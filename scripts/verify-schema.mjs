/**
 * Verifies the applied schema matches what migrations/001_init.sql intended.
 *
 *     node --env-file=.env scripts/verify-schema.mjs
 *
 * Read-only apart from one deliberately-failing INSERT that proves the vector
 * dimension constraint is enforced. Safe to run against a populated database.
 *
 * Exists because "the migration exited 0" and "the schema is correct" are
 * different claims. In particular it re-checks, against the real tables rather
 * than a smoke-test table, that the hybrid retrieval query in SPEC §5.1 is
 * index-accelerated -- if that ever silently regresses to a full scan, every
 * performance claim in the README becomes false.
 */

import pg from 'pg';

const { Client } = pg;

const url = process.env.DATABASE_URL;
if (!url || url.includes('PASTE_PASSWORD_HERE')) {
  console.error('DATABASE_URL is not set. Run with: node --env-file=.env scripts/verify-schema.mjs');
  process.exit(1);
}

const EXPECTED_TABLES = [
  'agent_runs',
  'case_embeddings',
  'disruption_cases',
  'passengers',
  'proposed_actions',
  'resolutions',
  'schema_migrations',
];

const client = new Client({
  connectionString: url,
  ssl: { rejectUnauthorized: true },
  statement_timeout: 60_000,
  connectionTimeoutMillis: 20_000,
});

const q = async (sql, params = []) => (await client.query(sql, params)).rows;
let problems = 0;
const fail = (m) => { problems += 1; console.log(`  FAIL  ${m}`); };
const pass = (m) => console.log(`  PASS  ${m}`);

await client.connect();

try {
  console.log('=== tables ===');
  const present = (await q(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`,
  )).map((r) => r.table_name);

  for (const t of EXPECTED_TABLES) {
    if (present.includes(t)) {
      const [{ n }] = await q(`SELECT count(*)::INT AS n FROM "${t}"`);
      pass(`${t.padEnd(20)} ${n} rows`);
    } else {
      fail(`${t} MISSING`);
    }
  }
  for (const t of present) {
    if (!EXPECTED_TABLES.includes(t)) console.log(`  ..    ${t} (unexpected, not fatal)`);
  }

  console.log('\n=== vector indexes ===');
  for (const t of ['case_embeddings', 'resolutions']) {
    const idx = (await q(`SHOW INDEXES FROM ${t}`)).filter((r) => /vec/i.test(r.index_name));
    if (idx.length === 0) fail(`${t}: no vector index found`);
    else {
      for (const r of idx) {
        console.log(`  ..    ${t.padEnd(16)} ${r.index_name.padEnd(32)} col=${r.column_name} seq=${r.seq_in_index}`);
      }
      pass(`${t} has a vector index`);
    }
  }

  console.log('\n=== hybrid retrieval is index-accelerated (SPEC §5.1) ===');
  const probe = `[${Array.from({ length: 1024 }, (_, i) => (i % 7) / 10).join(',')}]`;
  const plan = (await q(
    `EXPLAIN SELECT case_id, summary_text FROM case_embeddings
      WHERE case_status = 'resolved' ORDER BY embedding <=> $1 LIMIT 5`,
    [probe],
  )).map((r) => Object.values(r)[0]).join('\n');

  console.log(plan.split('\n').map((l) => `        ${l}`).join('\n'));

  if (/vector search/i.test(plan)) pass('plan uses a vector search');
  else fail('plan does NOT use the vector index -- this is a full scan');

  if (/prefix spans/i.test(plan)) pass('the case_status filter is pushed into the index as a prefix span');
  else fail('no prefix span -- the structured filter is not index-accelerated');

  console.log('\n=== vector dimension is enforced ===');
  try {
    await client.query(
      `INSERT INTO case_embeddings (case_id, summary_text, case_status, embedding, model_id)
       VALUES (gen_random_uuid(), 'dimension probe', 'open', '[1,2,3]', 'verify-schema')`,
    );
    fail('a 3-dimension vector was accepted into a VECTOR(1024) column');
    await client.query(`DELETE FROM case_embeddings WHERE model_id = 'verify-schema'`);
  } catch (err) {
    pass(`rejected: ${err.message.split('\n')[0]}`);
  }

  console.log(problems === 0 ? '\nAll checks passed.' : `\n${problems} check(s) FAILED.`);
  process.exitCode = problems === 0 ? 0 : 1;
} catch (err) {
  console.error('\nFATAL:', err.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
