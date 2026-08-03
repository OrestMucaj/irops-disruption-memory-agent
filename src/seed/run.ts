import { createPool, toVectorLiteral } from '../db.js';
import { loadConfig } from '../config.js';
import { createEmbeddingProvider } from '../providers/index.js';
import type { EmbeddingProvider } from '../providers/index.js';

import { generateDataset } from './generate.js';
import { buildCaseSummary, buildResolutionSummary } from './summary.js';
import type { GeneratedCase } from './types.js';

/**
 * Seeds the memory layer with synthetic disruption history.
 *
 *     npm run build
 *     node --env-file=.env dist/seed/run.js --reset
 *
 * ALL DATA IS SYNTHETIC (SPEC §1.1). See src/seed/domain.ts for provenance.
 *
 * Two design points worth not undoing:
 *
 *  1. **One transaction per case.** The case, its passengers, its embedding and
 *     its resolution commit together or not at all. This is the SPEC §4 claim
 *     made real -- vectors and transactional state live in one system, so there
 *     is no window in which the agent remembers a case that the operational
 *     tables do not have, or vice versa. A separate vector store could not do
 *     this without a distributed transaction.
 *
 *  2. **No bulk vector insert.** NOTES.md §1.9 records that large batch inserts
 *     of VECTOR values degrade performance, and `IMPORT INTO` is unsupported on
 *     tables carrying a vector index. Row-at-a-time is the documented path, not
 *     a naive one.
 */

interface Args {
  reset: boolean;
  seed: number;
  resolved: number;
  open: number;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string, fallback: number): number => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    if (hit === undefined) return fallback;
    const value = Number(hit.slice(name.length + 3));
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`--${name} must be a non-negative integer`);
    }
    return value;
  };

  return {
    reset: argv.includes('--reset'),
    seed: get('seed', 20260729),
    resolved: get('resolved', 80),
    open: get('open', 4),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const embedder = createEmbeddingProvider(config);
  const pool = createPool(config);

  console.log(`embedding provider : ${embedder.name} (${embedder.modelId}, ${embedder.dimensions}d)`);
  console.log(`seed               : ${args.seed}`);
  console.log(`cases              : ${args.resolved} resolved + ${args.open} open`);

  try {
    const countResult = await pool.query<{ count: string }>(
      'SELECT count(*)::STRING AS count FROM disruption_cases',
    );
    const existing = Number(countResult.rows[0]?.count ?? '0');
    if (existing > 0) {
      if (!args.reset) {
        console.error(
          `\n${existing} cases already present. Re-run with --reset to replace them, ` +
            'or point DATABASE_URL at an empty database.',
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`\nremoving ${existing} existing cases ... `);
      // Cascades to passengers, case_embeddings, resolutions and
      // proposed_actions. agent_runs survives by design (ON DELETE SET NULL) --
      // wiping the seed must not destroy the observability trail.
      await pool.query('DELETE FROM disruption_cases');
      console.log('done');
    }

    const dataset = generateDataset({
      seed: args.seed,
      resolvedCases: args.resolved,
      openCases: args.open,
    });

    console.log(`\nseeding ${dataset.length} cases...`);
    const started = Date.now();
    let done = 0;

    for (const generated of dataset) {
      await insertCase(pool, embedder, generated);
      done += 1;
      if (done % 10 === 0 || done === dataset.length) {
        process.stdout.write(`  ${done}/${dataset.length}\r`);
      }

      // Bedrock throttles embedding models by requests-per-minute, not tokens
      // (NOTES.md §4.5). Pace the loop rather than discovering the limit by
      // being rate-limited halfway through a seed.
      if (embedder.name === 'bedrock') {
        await sleep(120);
      }
    }

    console.log(`\nseeded ${dataset.length} cases in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    await printSummary(pool);
  } finally {
    await pool.end();
  }
}

async function insertCase(
  pool: ReturnType<typeof createPool>,
  embedder: EmbeddingProvider,
  generated: GeneratedCase,
): Promise<void> {
  const { case: c, passengers, resolution } = generated;

  // Embed outside the transaction: a model call is slow and can fail, and
  // holding a database transaction open across it would be a needless lock.
  const summaryText = buildCaseSummary(c, passengers);
  const caseVector = await embedder.embed(summaryText);

  const resolutionSummary = resolution === null ? null : buildResolutionSummary(c, resolution);
  const resolutionVector = resolutionSummary === null
    ? null
    : await embedder.embed(resolutionSummary);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO disruption_cases (
         id, flight_no, origin, destination, scheduled_dep, actual_dep,
         delay_minutes, cause, aircraft_type, pax_count, misconnect_count,
         priority_pax_count, status, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        c.id, c.flightNo, c.origin, c.destination, c.scheduledDep, c.actualDep,
        c.delayMinutes, c.cause, c.aircraftClass, c.paxCount, c.misconnectCount,
        c.priorityPaxCount, c.status, c.createdAt,
      ],
    );

    // One multi-row INSERT rather than one per passenger. With ~18 passengers a
    // case and a cluster an ocean away, per-row inserts spent most of the seed
    // waiting on round trips (254s -> well under a minute).
    //
    // The NOTES.md §1.9 warning about batching applies to VECTOR values, which
    // this table has none of. Embeddings are still written one row at a time,
    // below.
    //
    // Values are still fully parameterised (SPEC §5.4) -- only the placeholder
    // list is constructed, never the data.
    if (passengers.length > 0) {
      const columns = 8;
      const tuples = passengers
        .map((_, i) => `(${Array.from({ length: columns }, (_, j) => `$${i * columns + j + 1}`).join(',')})`)
        .join(',');
      const values = passengers.flatMap((p) => [
        p.caseId, p.paxRef, p.priorityTier, p.onwardFlight, p.connectionMinutes,
        p.connectionStatus, p.rebookedTo, p.specialHandling,
      ]);

      await client.query(
        `INSERT INTO passengers (
           case_id, pax_ref, priority_tier, onward_flight, connection_minutes,
           connection_status, rebooked_to, special_handling
         ) VALUES ${tuples}`,
        values,
      );
    }

    // case_status is denormalized here purely to be the vector index prefix
    // (NOTES.md §1.3). It must always equal disruption_cases.status -- which is
    // exactly why it is written in the same transaction as the case row.
    await client.query(
      `INSERT INTO case_embeddings (case_id, summary_text, case_status, embedding, model_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [c.id, summaryText, c.status, toVectorLiteral(caseVector), embedder.modelId],
    );

    if (resolution !== null && resolutionVector !== null) {
      await client.query(
        `INSERT INTO resolutions (
           case_id, actions_taken, outcome_notes, outcome_rating, resolved_at,
           embedding, model_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          resolution.caseId,
          JSON.stringify(resolution.actionsTaken),
          resolution.outcomeNotes,
          resolution.outcomeRating,
          resolution.resolvedAt,
          toVectorLiteral(resolutionVector),
          embedder.modelId,
        ],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Distribution report, so the dataset can be eyeballed rather than trusted. */
async function printSummary(pool: ReturnType<typeof createPool>): Promise<void> {
  const show = async (title: string, sql: string): Promise<void> => {
    const { rows } = await pool.query(sql);
    console.log(`\n${title}`);
    for (const row of rows) {
      const values = Object.values(row);
      console.log(`  ${String(values[0]).padEnd(28)} ${String(values[1] ?? '')}`);
    }
  };

  await show('cases by cause', `
    SELECT cause, count(*)::STRING FROM disruption_cases GROUP BY cause ORDER BY count(*) DESC`);

  await show('cases by status', `
    SELECT status, count(*)::STRING FROM disruption_cases GROUP BY status ORDER BY status`);

  await show('resolution outcome ratings', `
    SELECT outcome_rating::STRING, count(*)::STRING FROM resolutions
    GROUP BY outcome_rating ORDER BY outcome_rating`);

  await show('row counts', `
    SELECT 'disruption_cases', count(*)::STRING FROM disruption_cases
    UNION ALL SELECT 'passengers', count(*)::STRING FROM passengers
    UNION ALL SELECT 'case_embeddings', count(*)::STRING FROM case_embeddings
    UNION ALL SELECT 'resolutions', count(*)::STRING FROM resolutions`);

  await show('denormalization drift check (must be empty)', `
    SELECT c.id::STRING, c.status FROM disruption_cases c
    JOIN case_embeddings e ON e.case_id = c.id
    WHERE c.status <> e.case_status`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
