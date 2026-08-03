import { loadConfig } from '../config.js';
import { checkEmbeddingModelConsistency, createPool } from '../db.js';
import { createEmbeddingProvider, createLLMProvider } from '../providers/index.js';

import { runAgent } from './run.js';

/**
 * Runs the agent against one case and prints what happened.
 *
 *     node --env-file=.env dist/agent/cli.js                # first open case
 *     node --env-file=.env dist/agent/cli.js <case-id>
 *
 * This is the M3 exit criterion made runnable: retrieval -> model -> validated
 * JSON actions -> persistence, end to end against a seeded case.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const embedder = createEmbeddingProvider(config);
  const llm = createLLMProvider(config);
  const pool = createPool(config);

  console.log(`embedding : ${embedder.name} (${embedder.modelId})`);
  console.log(`llm       : ${llm.name} (${llm.modelId})`);
  if (llm.name === 'heuristic') {
    console.log('            ^ NOT a language model. Decision-tree stand-in for offline development.');
  }

  try {
    // Fail loudly rather than retrieving nonsense. See db.ts for why this is
    // the sharpest footgun in the system.
    const mismatch = await checkEmbeddingModelConsistency(pool, embedder.modelId);
    if (mismatch !== null) {
      console.error(`\nEMBEDDING MODEL MISMATCH\n  ${mismatch}`);
      process.exitCode = 1;
      return;
    }

    let caseId = process.argv[2];

    if (caseId === undefined) {
      const { rows } = await pool.query(
        `SELECT id::STRING AS id, flight_no, cause, delay_minutes
           FROM disruption_cases
          WHERE status IN ('open', 'planned')
          ORDER BY scheduled_dep DESC
          LIMIT 1`,
      );
      const row = rows[0];
      if (row === undefined) {
        console.error('\nNo open cases. Seed the database first: npm run seed -- --reset');
        process.exitCode = 1;
        return;
      }
      caseId = String(row.id);
      console.log(`case      : ${caseId} (${row.flight_no}, ${row.cause}, ${row.delay_minutes}min)`);
    } else {
      console.log(`case      : ${caseId}`);
    }

    const started = Date.now();
    const result = await runAgent(pool, embedder, llm, config, caseId);

    console.log(`\nrun_id    : ${result.runId}`);
    console.log(`latency   : ${result.latencyMs}ms (wall ${Date.now() - started}ms)`);
    console.log(`model calls: ${result.modelCalls}`);

    console.log(`\n=== retrieved precedents (${result.precedents.length}) ===`);
    for (const p of result.precedents) {
      const rating = p.outcome?.outcomeRating ?? null;
      const flag = rating !== null && rating <= 2 ? '  <-- went badly' : '';
      console.log(`  d=${p.distance.toFixed(4)}  ${p.caseId}  ${p.cause.padEnd(10)} rating=${rating ?? '-'}${flag}`);
    }

    if (result.error !== null) {
      console.log(`\n=== FAILED ===\n  ${result.error}`);
    } else {
      console.log(`\n=== proposed actions (${result.actions.length}) ===`);
      for (const a of result.actions) {
        console.log(
          `\n  ${a.action_type.toUpperCase()}` +
            (a.target_pax_ref === null ? '  (case-level)' : `  -> ${a.target_pax_ref}`) +
            `  confidence=${a.confidence}`,
        );
        console.log(`    ${a.rationale}`);
        console.log(`    cites: ${a.precedent_case_ids.length > 0 ? a.precedent_case_ids.join(', ') : '(none)'}`);
      }
    }

    if (result.warnings.length > 0) {
      console.log(`\n=== warnings (${result.warnings.length}) ===`);
      for (const w of result.warnings) console.log(`  - ${w}`);
    }

    // Prove the run was recorded. SPEC §5.4 requires every run in agent_runs,
    // and an observability claim you have not looked at is a hope.
    const { rows: runRows } = await pool.query(
      `SELECT prompt_tokens, completion_tokens, latency_ms,
              array_length(retrieved_case_ids, 1) AS retrieved, error
         FROM agent_runs WHERE id = $1`,
      [result.runId],
    );
    console.log('\n=== agent_runs row ===');
    console.log(`  ${JSON.stringify(runRows[0])}`);

    const { rows: actionRows } = await pool.query(
      `SELECT status, count(*)::STRING AS n FROM proposed_actions
        WHERE agent_run_id = $1 GROUP BY status`,
      [result.runId],
    );
    console.log(`  persisted actions: ${JSON.stringify(actionRows)}`);

    process.exitCode = result.error === null ? 0 : 1;
  } finally {
    await pool.end();
  }
}

await main();
