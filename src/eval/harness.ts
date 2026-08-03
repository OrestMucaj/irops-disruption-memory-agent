import { loadConfig } from '../config.js';
import type { Config } from '../config.js';
import { createPool } from '../db.js';
import { runAgent } from '../agent/run.js';
import { loadCase } from '../agent/retrieval.js';
import { findCoverageGaps } from '../agent/schema.js';
import { createEmbeddingProvider, createLLMProvider } from '../providers/index.js';
import { idealActions } from '../seed/generate.js';
import type { ActionType } from '../domain/vocabulary.js';

/**
 * A/B evaluation: does the memory layer actually change the agent's answers,
 * and does it change them for the better?
 *
 *     npm run eval -- --cases=20
 *
 * WHY THIS EXISTS
 *
 * "The agent cites precedent" is easy to demonstrate and proves nothing — a
 * model with no precedent at all still produces fluent, plausible plans. The
 * question that matters is whether retrieval changes the output in a direction
 * that can be independently checked.
 *
 * It can be, here, because this corpus has a knowable right answer. The
 * historical outcomes were generated from an explicit playbook
 * (`idealActions`): the correct response is determined by cause, severity and
 * above all time of day, and 28% of the seeded cases deviate from it and record
 * the worse result that followed. So for any case, the playbook-correct action
 * set is known — without asking the model.
 *
 * METHOD
 *
 * Each sampled case is run twice through the real `runAgent` path:
 *
 *   WITH precedent    retrievalTopK from config (normally 5)
 *   WITHOUT precedent retrievalTopK = 0, so retrieval returns nothing and the
 *                     model sees only the case facts
 *
 * Both are scored against the playbook. Running the real code path rather than
 * a reimplementation matters: an evaluation of a parallel pipeline measures the
 * parallel pipeline.
 *
 * WHAT THIS DOES NOT SHOW
 *
 * The ground truth is this repository's own generator, not the airline
 * industry. A good score means the agent recovered a learnable rule from
 * precedent. It does not mean the agent is right about real operations, and the
 * README says so.
 *
 * Every run this creates is deleted afterwards, so the demo data is unchanged.
 */

interface Score {
  /** Action types proposed that the playbook also wants. */
  truePositives: number;
  /** Action types proposed that the playbook does not want. */
  falsePositives: number;
  /** Action types the playbook wants that were not proposed. */
  falseNegatives: number;
  /** Every passenger with a missed connection had a reaccommodating action. */
  coverageOk: boolean;
  /** Cited at least one precedent. */
  citedPrecedent: boolean;
  failed: boolean;
}

interface Totals {
  cases: number;
  tp: number;
  fp: number;
  fn: number;
  coverageOk: number;
  cited: number;
  failures: number;
  latencyMs: number;
}

const empty = (): Totals => ({
  cases: 0, tp: 0, fp: 0, fn: 0, coverageOk: 0, cited: 0, failures: 0, latencyMs: 0,
});

function parseArgs(argv: readonly string[]): { sample: number } {
  const hit = argv.find((a) => a.startsWith('--cases='));
  const value = hit === undefined ? 20 : Number(hit.slice('--cases='.length));
  if (!Number.isInteger(value) || value < 1) throw new Error('--cases must be a positive integer');
  return { sample: value };
}

async function main(): Promise<void> {
  const { sample } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const embedder = createEmbeddingProvider(config);
  const llm = createLLMProvider(config);
  const pool = createPool(config);

  // Same config with retrieval switched off. This is the only difference
  // between the two arms.
  const noMemoryConfig: Config = { ...config, retrievalTopK: 0 };

  console.log(`embeddings : ${embedder.modelId}`);
  console.log(`reasoning  : ${llm.modelId}`);
  console.log(`sample     : ${sample} cases x 2 runs\n`);

  const createdRunIds: string[] = [];

  try {
    // Deterministic sample: ordered by id, so re-running compares like with
    // like rather than drifting with whatever the database returns first.
    const { rows } = await pool.query<{ id: string }>(
      `SELECT c.id::STRING AS id
         FROM disruption_cases c
        WHERE c.status = 'resolved'
          AND EXISTS (SELECT 1 FROM passengers p WHERE p.case_id = c.id)
        ORDER BY c.id
        LIMIT $1`,
      [sample],
    );

    if (rows.length === 0) {
      console.error('No resolved cases with passengers. Run: npm run seed -- --reset');
      process.exitCode = 1;
      return;
    }

    const withMemory = empty();
    const withoutMemory = empty();
    const disagreements: string[] = [];

    for (const [index, row] of rows.entries()) {
      const caseId = row.id;

      const loaded = await loadCase(pool, caseId);
      if (loaded === null) continue;
      const ideal = idealActions(loaded.subject, loaded.passengers);

      const a = await scoreOne(pool, embedder, llm, config, caseId, ideal, createdRunIds);
      const b = await scoreOne(pool, embedder, llm, noMemoryConfig, caseId, ideal, createdRunIds);

      accumulate(withMemory, a);
      accumulate(withoutMemory, b);

      const f1a = f1(a);
      const f1b = f1(b);
      if (Math.abs(f1a - f1b) > 0.01) {
        disagreements.push(
          `${caseId.slice(0, 8)}  with=${f1a.toFixed(2)} without=${f1b.toFixed(2)}  ` +
            `ideal={${[...ideal].join(',')}}`,
        );
      }

      process.stdout.write(`  ${index + 1}/${rows.length}\r`);
    }

    console.log(`\n`);
    report(withMemory, withoutMemory);

    if (disagreements.length > 0) {
      console.log('\n=== cases where memory changed the answer ===');
      for (const line of disagreements.slice(0, 15)) console.log(`  ${line}`);
      if (disagreements.length > 15) console.log(`  ... and ${disagreements.length - 15} more`);
    } else {
      console.log('\nMemory changed the answer on NO case. That is a finding, not a success.');
    }
  } finally {
    // Leave the demo data exactly as it was found.
    if (createdRunIds.length > 0) {
      await pool.query('DELETE FROM proposed_actions WHERE agent_run_id = ANY($1::UUID[])', [createdRunIds]);
      await pool.query('DELETE FROM agent_runs WHERE id = ANY($1::UUID[])', [createdRunIds]);
      console.log(`\ncleaned up ${createdRunIds.length} evaluation runs`);
    }
    await pool.end();
  }
}

async function scoreOne(
  pool: ReturnType<typeof createPool>,
  embedder: ReturnType<typeof createEmbeddingProvider>,
  llm: ReturnType<typeof createLLMProvider>,
  config: Config,
  caseId: string,
  ideal: ReadonlySet<ActionType>,
  createdRunIds: string[],
): Promise<Score & { latencyMs: number }> {
  const result = await runAgent(pool, embedder, llm, config, caseId);
  createdRunIds.push(result.runId);

  if (result.error !== null) {
    return {
      truePositives: 0, falsePositives: 0, falseNegatives: ideal.size,
      coverageOk: false, citedPrecedent: false, failed: true,
      latencyMs: result.latencyMs,
    };
  }

  const proposed = new Set(result.actions.map((a) => a.action_type));

  let tp = 0;
  for (const type of proposed) if (ideal.has(type as ActionType)) tp += 1;

  return {
    truePositives: tp,
    falsePositives: proposed.size - tp,
    falseNegatives: ideal.size - tp,
    coverageOk: result.coverageGaps.length === 0,
    citedPrecedent: result.actions.some((a) => a.precedent_case_ids.length > 0),
    failed: false,
    latencyMs: result.latencyMs,
  };
}

/**
 * Accumulates a score, keeping failed runs OUT of the quality figures.
 *
 * A run that errored contributes nothing to precision or recall — it is counted
 * separately as a failure. Folding failures in as zero-scoring runs is what
 * misled the first evaluation: 5 of 30 with-precedent runs hit the model's
 * token limit, scored 0, and dragged the aggregate below the no-precedent arm.
 * The conclusion "memory makes the agent worse" was really "memory makes the
 * output longer and the cap was too low".
 *
 * Reliability and answer quality are different properties. Reporting them as
 * one number can only mislead.
 */
function accumulate(totals: Totals, score: Score & { latencyMs: number }): void {
  totals.latencyMs += score.latencyMs;

  if (score.failed) {
    totals.failures += 1;
    return;
  }

  totals.cases += 1;
  totals.tp += score.truePositives;
  totals.fp += score.falsePositives;
  totals.fn += score.falseNegatives;
  if (score.coverageOk) totals.coverageOk += 1;
  if (score.citedPrecedent) totals.cited += 1;
}

function f1(score: Score): number {
  const precision = score.truePositives + score.falsePositives === 0
    ? 0 : score.truePositives / (score.truePositives + score.falsePositives);
  const recall = score.truePositives + score.falseNegatives === 0
    ? 0 : score.truePositives / (score.truePositives + score.falseNegatives);
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function report(withMemory: Totals, withoutMemory: Totals): void {
  const stats = (t: Totals) => {
    const precision = t.tp + t.fp === 0 ? 0 : t.tp / (t.tp + t.fp);
    const recall = t.tp + t.fn === 0 ? 0 : t.tp / (t.tp + t.fn);
    const fScore = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return { precision, recall, fScore };
  };

  const a = stats(withMemory);
  const b = stats(withoutMemory);
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const delta = (x: number, y: number) => {
    const d = (x - y) * 100;
    return `${d >= 0 ? '+' : ''}${d.toFixed(1)} pts`;
  };

  console.log('=== Agreement with the generator playbook ===');
  console.log('  (which action TYPES the playbook says this case needs)\n');
  console.log('                        with memory   without memory   difference');
  console.log(`  recall                ${pct(a.recall).padStart(8)}      ${pct(b.recall).padStart(8)}       ${delta(a.recall, b.recall)}`);
  console.log(`    (of the actions the playbook wants, how many were proposed)`);
  console.log(`  precision             ${pct(a.precision).padStart(8)}      ${pct(b.precision).padStart(8)}       ${delta(a.precision, b.precision)}`);
  console.log(`    (of the actions proposed, how many the playbook wants)`);
  console.log(`  F1                    ${pct(a.fScore).padStart(8)}      ${pct(b.fScore).padStart(8)}       ${delta(a.fScore, b.fScore)}`);

  const cov = (t: Totals) => t.cases === 0 ? 0 : t.coverageOk / t.cases;
  console.log('\n=== Passenger coverage (deterministic check, not model output) ===');
  console.log(`  cases with every missed passenger handled`);
  console.log(`                        ${pct(cov(withMemory)).padStart(8)}      ${pct(cov(withoutMemory)).padStart(8)}       ${delta(cov(withMemory), cov(withoutMemory))}`);

  console.log('\n=== Sanity checks ===');
  console.log(`  runs scored           ${String(withMemory.cases).padStart(8)}      ${String(withoutMemory.cases).padStart(8)}`);
  console.log(`  runs that cited       ${String(withMemory.cited).padStart(8)}      ${String(withoutMemory.cited).padStart(8)}   (without memory MUST be 0)`);
  console.log(`  FAILED runs           ${String(withMemory.failures).padStart(8)}      ${String(withoutMemory.failures).padStart(8)}   (excluded from the scores above)`);
  console.log(`  mean latency          ${String(Math.round(withMemory.latencyMs / Math.max(1, withMemory.cases))).padStart(6)}ms      ${String(Math.round(withoutMemory.latencyMs / Math.max(1, withoutMemory.cases))).padStart(6)}ms`);

  if (withoutMemory.cited > 0) {
    console.log('\n  WARNING: the no-memory arm cited precedents. Retrieval was not actually disabled.');
  }
  if (withMemory.failures > 0 || withoutMemory.failures > 0) {
    console.log('\n  NOTE: failures are a reliability problem, not a quality one, and are');
    console.log('  reported separately for that reason. Investigate them before reading');
    console.log('  anything into the scores -- a systematically failing arm looks exactly');
    console.log('  like a systematically wrong one once the two are averaged together.');
  }
}

await main();
