import { createPool, toVectorLiteral } from '../db.js';
import { loadConfig } from '../config.js';
import { createEmbeddingProvider } from '../providers/index.js';

import { misconnectPressureOf, recoveryWindowOf, severityOf } from './domain.js';

/**
 * M2 exit criterion: does semantic search over the seeded data return
 * *intuitively sensible* precedents?
 *
 *     node --env-file=.env dist/seed/check-retrieval.js
 *
 * SPEC M2 says that if it does not, `summary_text` generation must be fixed
 * before anything downstream is built. So this needs to be a real measurement,
 * not three hand-picked examples that happen to look convincing.
 *
 * Method: leave-one-out over every resolved case. Embed the case, retrieve the
 * 5 nearest *other* resolved cases, and ask how often they share the
 * operational characteristics that should drive similarity -- cause, delay
 * severity, and recovery window. Each is scored against the baseline you would
 * get by drawing 5 cases at random from the same corpus, computed from the
 * actual class distribution rather than assumed.
 *
 * Beating the baseline is the bar. Matching it means `summary_text` is noise
 * and the whole retrieval premise is unsupported.
 */

interface CaseRow {
  id: string;
  cause: string;
  delay_minutes: number;
  scheduled_dep: Date;
  pax_count: number;
  misconnect_count: number;
  summary_text: string;
}

interface Neighbour {
  case_id: string;
  cause: string;
  delay_minutes: number;
  scheduled_dep: Date;
  distance: number;
  outcome_rating: number | null;
  outcome_notes: string | null;
  actions: unknown;
}

const TOP_K = 5;

async function main(): Promise<void> {
  const config = loadConfig();
  const embedder = createEmbeddingProvider(config);
  const pool = createPool(config);

  console.log(`embedding provider : ${embedder.name} (${embedder.modelId})`);
  console.log(`top-k              : ${TOP_K}\n`);

  try {
    const cases = (await pool.query<CaseRow>(`
      SELECT c.id::STRING AS id, c.cause, c.delay_minutes, c.scheduled_dep,
             c.pax_count, c.misconnect_count, e.summary_text
        FROM disruption_cases c
        JOIN case_embeddings e ON e.case_id = c.id
       WHERE c.status = 'resolved'
       ORDER BY c.scheduled_dep
    `)).rows;

    if (cases.length < 10) {
      console.error(`Only ${cases.length} resolved cases. Seed the database first.`);
      process.exitCode = 1;
      return;
    }

    // --- Baselines from the actual corpus distribution ----------------------
    const baseline = {
      cause: chanceOfMatch(cases.map((c) => c.cause)),
      severity: chanceOfMatch(cases.map((c) => severityOf(c.delay_minutes))),
      window: chanceOfMatch(cases.map((c) => recoveryWindowOf(new Date(c.scheduled_dep)))),
    };

    let causeHits = 0;
    let severityHits = 0;
    let windowHits = 0;
    let comparisons = 0;
    let selfLeaks = 0;

    const examples: Array<{ probe: CaseRow; neighbours: Neighbour[] }> = [];

    for (const probe of cases) {
      const vector = await embedder.embed(probe.summary_text);

      const neighbours = (await pool.query<Neighbour>(
        `SELECT e.case_id::STRING AS case_id,
                c.cause,
                c.delay_minutes,
                c.scheduled_dep,
                e.embedding <=> $1 AS distance,
                r.outcome_rating,
                r.outcome_notes,
                r.actions_taken AS actions
           FROM case_embeddings e
           JOIN disruption_cases c ON c.id = e.case_id
           LEFT JOIN resolutions r ON r.case_id = e.case_id
          WHERE e.case_status = 'resolved'
            AND e.case_id <> $2
          ORDER BY e.embedding <=> $1
          LIMIT $3`,
        [toVectorLiteral(vector), probe.id, TOP_K],
      )).rows;

      if (neighbours.some((n) => n.case_id === probe.id)) selfLeaks += 1;

      const probeSeverity = severityOf(probe.delay_minutes);
      const probeWindow = recoveryWindowOf(new Date(probe.scheduled_dep));

      for (const n of neighbours) {
        comparisons += 1;
        if (n.cause === probe.cause) causeHits += 1;
        if (severityOf(n.delay_minutes) === probeSeverity) severityHits += 1;
        if (recoveryWindowOf(new Date(n.scheduled_dep)) === probeWindow) windowHits += 1;
      }

      if (examples.length < 3 && neighbours.length >= 3) {
        examples.push({ probe, neighbours });
      }
    }

    // --- Report -------------------------------------------------------------
    console.log('=== Leave-one-out retrieval quality ===');
    console.log(`  ${cases.length} probes, ${comparisons} precedent comparisons\n`);

    const report = (label: string, hits: number, chance: number): boolean => {
      const actual = hits / comparisons;
      const lift = chance > 0 ? actual / chance : 0;
      const ok = actual > chance * 1.25;
      console.log(
        `  ${label.padEnd(20)} ${(actual * 100).toFixed(1).padStart(5)}%  ` +
          `(random baseline ${(chance * 100).toFixed(1)}%, lift ${lift.toFixed(2)}x)  ` +
          `${ok ? 'PASS' : 'WEAK'}`,
      );
      return ok;
    };

    const causeOk = report('same cause', causeHits, baseline.cause);
    const severityOk = report('same severity', severityHits, baseline.severity);
    const windowOk = report('same recovery window', windowHits, baseline.window);

    if (selfLeaks > 0) {
      console.log(`\n  WARNING: ${selfLeaks} probes retrieved themselves despite the exclusion.`);
    }

    // --- Qualitative: what a human would actually look at --------------------
    console.log('\n=== Sample retrievals (eyeball these) ===');
    for (const { probe, neighbours } of examples) {
      console.log(`\n--- PROBE ---`);
      console.log(`  ${probe.summary_text}`);
      console.log(`  [${probe.cause} / ${severityOf(probe.delay_minutes)} / ` +
        `${recoveryWindowOf(new Date(probe.scheduled_dep))} / ` +
        `${misconnectPressureOf(probe.misconnect_count, probe.pax_count)}]`);
      console.log('  retrieved precedents:');
      for (const n of neighbours.slice(0, 3)) {
        const actions = Array.isArray(n.actions)
          ? n.actions.map((a) => (a as { action_type: string }).action_type).join('+')
          : '-';
        console.log(
          `    d=${Number(n.distance).toFixed(4)}  ${n.cause.padEnd(10)} ` +
            `${severityOf(n.delay_minutes).padEnd(8)} ` +
            `${recoveryWindowOf(new Date(n.scheduled_dep)).padEnd(14)} ` +
            `rating=${n.outcome_rating ?? '-'}  ${actions}`,
        );
        if (n.outcome_notes !== null) {
          console.log(`         "${n.outcome_notes.slice(0, 96)}"`);
        }
      }
    }

    const passed = causeOk && severityOk && windowOk;
    console.log(
      passed
        ? '\nM2 exit criterion: PASS -- retrieval beats chance on all three axes.'
        : '\nM2 exit criterion: NOT MET -- fix summary_text before building downstream.',
    );
    process.exitCode = passed ? 0 : 1;
  } finally {
    await pool.end();
  }
}

/**
 * Probability that two cases drawn at random share a label, given the observed
 * distribution. This is the number retrieval has to beat; assuming a uniform
 * baseline would flatter it.
 */
function chanceOfMatch(labels: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const total = labels.length;
  let sum = 0;
  for (const n of counts.values()) {
    sum += (n / total) ** 2;
  }
  return sum;
}

await main();
