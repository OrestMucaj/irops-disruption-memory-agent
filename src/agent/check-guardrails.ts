import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { createEmbeddingProvider, FakeLLMProvider } from '../providers/index.js';

import { runAgent } from './run.js';

/**
 * Exercises the failure paths SPEC §5.2 and §5.4 require.
 *
 *     node --env-file=.env dist/agent/check-guardrails.js
 *
 * Happy-path demos prove almost nothing about an agent. What matters is what
 * happens when the model returns rubbish, or confidently cites a case that does
 * not exist, or names a passenger who is not on the flight. Each scenario below
 * injects exactly that and asserts the system degrades the way it claims to.
 *
 * Cleans up every row it creates.
 */

interface Scenario {
  name: string;
  cannedResponse: string;
  expect: (r: Outcome) => string | null;
}

interface Outcome {
  error: string | null;
  actionCount: number;
  citationCount: number;
  warnings: readonly string[];
  loggedError: string | null;
  modelCalls: number;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const embedder = createEmbeddingProvider(config);
  const pool = createPool(config);

  try {
    const { rows } = await pool.query(
      `SELECT c.id::STRING AS id,
              (SELECT p.pax_ref FROM passengers p WHERE p.case_id = c.id LIMIT 1) AS pax_ref
         FROM disruption_cases c
        WHERE c.status IN ('open','planned')
          AND EXISTS (SELECT 1 FROM passengers p WHERE p.case_id = c.id)
        LIMIT 1`,
    );
    const subject = rows[0];
    if (subject === undefined) {
      console.error('No open case with passengers. Run: npm run seed -- --reset');
      process.exitCode = 1;
      return;
    }

    const caseId = String(subject.id);
    const realPax = String(subject.pax_ref);
    console.log(`case: ${caseId}\npax : ${realPax}\n`);

    const scenarios: Scenario[] = [
      {
        name: 'unparseable response degrades gracefully',
        cannedResponse: 'I think you should probably rebook some people. Sorry, no JSON today.',
        expect: (r) =>
          r.error === null ? 'expected an error state'
            : r.actionCount !== 0 ? 'expected no actions to be persisted'
            : r.loggedError === null ? 'expected the failure to be recorded in agent_runs'
            : r.modelCalls < 2 ? `expected a retry, got ${r.modelCalls} model call(s)`
            : null,
      },
      {
        name: 'valid JSON, wrong shape, degrades gracefully',
        cannedResponse: JSON.stringify({ actions: [{ action_type: 'teleport', confidence: 5 }] }),
        expect: (r) =>
          r.error === null ? 'expected an error state'
            : r.loggedError === null ? 'expected the failure to be recorded in agent_runs'
            : null,
      },
      {
        name: 'fabricated precedent citation is stripped, action survives',
        cannedResponse: JSON.stringify({
          actions: [{
            action_type: 'notify',
            target_pax_ref: null,
            rationale: 'Citing a case that was never retrieved.',
            precedent_case_ids: ['00000000-0000-4000-8000-000000000000'],
            confidence: 0.5,
          }],
        }),
        expect: (r) =>
          r.error !== null ? `unexpected error: ${r.error}`
            : r.actionCount !== 1 ? `expected the action to survive, got ${r.actionCount}`
            : r.citationCount !== 0 ? 'expected the fabricated citation to be removed'
            : r.warnings.length === 0 ? 'expected a warning about the removed citation'
            : null,
      },
      {
        name: 'fabricated passenger reference kills the action',
        cannedResponse: JSON.stringify({
          actions: [
            {
              action_type: 'rebook',
              target_pax_ref: 'SYNPAX-999999999',
              rationale: 'Targeting a passenger who is not on this flight.',
              precedent_case_ids: [],
              confidence: 0.9,
            },
            {
              action_type: 'notify',
              target_pax_ref: null,
              rationale: 'This one is fine and should survive.',
              precedent_case_ids: [],
              confidence: 0.8,
            },
          ],
        }),
        expect: (r) =>
          r.error !== null ? `unexpected error: ${r.error}`
            : r.actionCount !== 1 ? `expected exactly the safe action to survive, got ${r.actionCount}`
            : r.warnings.length === 0 ? 'expected a warning about the dropped action'
            : null,
      },
      {
        name: 'well-formed response is accepted and persisted',
        cannedResponse: JSON.stringify({
          actions: [{
            action_type: 'rebook',
            target_pax_ref: realPax,
            rationale: 'A legitimate action naming a real passenger.',
            precedent_case_ids: [],
            confidence: 0.75,
          }],
        }),
        expect: (r) =>
          r.error !== null ? `unexpected error: ${r.error}`
            : r.actionCount !== 1 ? `expected 1 action, got ${r.actionCount}`
            : null,
      },
    ];

    const runIds: string[] = [];
    let failures = 0;

    for (const scenario of scenarios) {
      const llm = new FakeLLMProvider({ cannedResponse: scenario.cannedResponse });
      const result = await runAgent(pool, embedder, llm, config, caseId);
      runIds.push(result.runId);

      const { rows: logged } = await pool.query(
        'SELECT error FROM agent_runs WHERE id = $1', [result.runId],
      );
      const { rows: persisted } = await pool.query(
        `SELECT count(*)::STRING AS n,
                coalesce(sum(array_length(precedent_case_ids, 1)), 0)::STRING AS citations
           FROM proposed_actions WHERE agent_run_id = $1`,
        [result.runId],
      );

      const outcome: Outcome = {
        error: result.error,
        actionCount: Number(persisted[0]?.n ?? '0'),
        citationCount: Number(persisted[0]?.citations ?? '0'),
        warnings: result.warnings,
        loggedError: (logged[0]?.error ?? null) as string | null,
        modelCalls: result.modelCalls,
      };

      const problem = scenario.expect(outcome);
      if (problem === null) {
        console.log(`  PASS  ${scenario.name}`);
      } else {
        failures += 1;
        console.log(`  FAIL  ${scenario.name}\n        ${problem}\n        ${JSON.stringify(outcome)}`);
      }
    }

    // --- Cleanup -----------------------------------------------------------
    // proposed_actions first: agent_runs is ON DELETE SET NULL, so deleting the
    // runs first would orphan the actions instead of removing them.
    await pool.query('DELETE FROM proposed_actions WHERE agent_run_id = ANY($1::UUID[])', [runIds]);
    await pool.query('DELETE FROM agent_runs WHERE id = ANY($1::UUID[])', [runIds]);
    console.log(`\ncleaned up ${runIds.length} test runs`);

    console.log(failures === 0 ? '\nAll guardrails held.' : `\n${failures} guardrail(s) FAILED.`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    await pool.end();
  }
}

await main();
