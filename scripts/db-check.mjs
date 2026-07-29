/**
 * Connectivity + vector-index smoke test.
 *
 * Answers, against a real cluster, every question NOTES.md flagged as
 * unverifiable from the docs:
 *
 *   1. Does a free Basic cluster do vector indexing at all?      (NOTES §1.8)
 *   2. Is feature.vector_index.enabled true by default?          (NOTES §1.8)
 *   3. Does `VECTOR INDEX (prefix, embedding opclass)` parse?    (001_init.sql)
 *   4. Does a vector index tolerate NULL embeddings?             (001_init.sql)
 *   5. Is the similarity query actually index-accelerated?       (SPEC §5.1)
 *   6. The SPEC M1 exit criterion: embed two strings, store them,
 *      retrieve the nearer one.
 *
 * Creates only tables prefixed `_smoke_` and drops them at the end. Run:
 *
 *     node --env-file=.env scripts/db-check.mjs
 *
 * Prints no secrets. The connection host is masked in output.
 */

import pg from 'pg';

const { Client } = pg;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Run with: node --env-file=.env scripts/db-check.mjs');
  process.exit(1);
}
if (url.includes('PASTE_PASSWORD_HERE')) {
  console.error('DATABASE_URL still contains the PASTE_PASSWORD_HERE placeholder.');
  console.error('Edit .env and insert the password from `ccloud cluster user create`.');
  process.exit(1);
}

const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => console.log(`  FAIL  ${m}`);
const info = (m) => console.log(`  ..    ${m}`);
const head = (m) => console.log(`\n=== ${m} ===`);

const client = new Client({
  connectionString: url,
  ssl: { rejectUnauthorized: true },
  statement_timeout: 60_000,
  connectionTimeoutMillis: 20_000,
});

/** Run SQL, returning { ok, rows, error }. Never throws. */
async function attempt(sql, params = []) {
  try {
    const res = await client.query(sql, params);
    return { ok: true, rows: res.rows };
  } catch (err) {
    return { ok: false, error: err.message.split('\n')[0] };
  }
}

const findings = {};

try {
  head('Connection');
  await client.connect();
  pass(`connected to ${new URL(url).hostname.replace(/^[^.]+/, '***')}:${new URL(url).port}`);

  // -- 1. Version -----------------------------------------------------------
  head('Server version');
  const v = await attempt('SELECT version() AS v');
  if (v.ok) {
    const full = v.rows[0].v;
    findings.version = full;
    info(full);
    const m = full.match(/v(\d+)\.(\d+)/);
    if (m) pass(`CockroachDB v${m[1]}.${m[2]}`);
  } else {
    fail(v.error);
  }

  // -- 2. The disputed cluster setting --------------------------------------
  head('feature.vector_index.enabled  (NOTES §1.8 -- docs contradict each other)');
  const setting = await attempt('SHOW CLUSTER SETTING feature.vector_index.enabled');
  if (setting.ok) {
    const val = Object.values(setting.rows[0])[0];
    findings.vectorSetting = String(val);
    if (val === true || val === 'true' || val === 'on') {
      pass(`already true -- the Vector Indexes page's "you must enable it" is stale`);
    } else {
      fail(`is ${val}. Try: SET CLUSTER SETTING feature.vector_index.enabled = true;`);
    }
  } else {
    fail(`cannot read it: ${setting.error}`);
    info('If this is a permissions error, Basic may not expose the setting.');
  }

  // -- 3. The two flagged DDL statements ------------------------------------
  head('Vector index DDL  (the two statements flagged in 001_init.sql)');
  await attempt('DROP TABLE IF EXISTS _smoke_vec');

  // 3a. The exact composition used in 001_init.sql: named index, prefix
  //     column, AND an explicit opclass. The docs only ever show these
  //     features in separate examples, never combined.
  const preferred = `
    CREATE TABLE _smoke_vec (
      id           UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      label        STRING       NOT NULL,
      case_status  STRING       NOT NULL,
      embedding    VECTOR(1024) NOT NULL,
      VECTOR INDEX idx_smoke_status_vec (case_status, embedding vector_cosine_ops)
    )`;
  const r1 = await attempt(preferred);
  findings.prefixPlusOpclass = r1.ok;
  if (r1.ok) {
    pass('prefix column + explicit opclass together -- 001_init.sql is correct as written');
  } else {
    fail(`prefix + opclass rejected: ${r1.error}`);
    info('Trying documented fallbacks to find what this version does accept...');

    for (const [name, ddl] of [
      ['prefix, no opclass', `CREATE TABLE _smoke_vec (id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, label STRING NOT NULL, case_status STRING NOT NULL, embedding VECTOR(1024) NOT NULL, VECTOR INDEX idx_smoke_status_vec (case_status, embedding))`],
      ['opclass, no prefix', `CREATE TABLE _smoke_vec (id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, label STRING NOT NULL, case_status STRING NOT NULL, embedding VECTOR(1024) NOT NULL, VECTOR INDEX idx_smoke_status_vec (embedding vector_cosine_ops))`],
      ['bare vector index', `CREATE TABLE _smoke_vec (id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, label STRING NOT NULL, case_status STRING NOT NULL, embedding VECTOR(1024) NOT NULL, VECTOR INDEX idx_smoke_status_vec (embedding))`],
    ]) {
      await attempt('DROP TABLE IF EXISTS _smoke_vec');
      const r = await attempt(ddl);
      if (r.ok) { pass(`fallback that works: ${name}`); findings.fallback = name; break; }
      fail(`${name}: ${r.error}`);
    }
  }

  // 3b. NULL embeddings in a vector index (resolutions.embedding is nullable)
  head('NULL embeddings in a vector index  (resolutions.embedding is nullable)');
  await attempt('DROP TABLE IF EXISTS _smoke_null');
  const nullable = await attempt(`
    CREATE TABLE _smoke_null (
      id        UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      embedding VECTOR(1024),
      VECTOR INDEX idx_smoke_null (embedding vector_cosine_ops)
    )`);
  if (nullable.ok) {
    const ins = await attempt('INSERT INTO _smoke_null (embedding) VALUES (NULL)');
    findings.nullEmbeddings = ins.ok;
    if (ins.ok) pass('nullable vector column indexes fine, and NULL inserts are accepted');
    else fail(`table created but NULL insert rejected: ${ins.error}`);
  } else {
    findings.nullEmbeddings = false;
    fail(`cannot index a nullable vector column: ${nullable.error}`);
    info('=> make resolutions.embedding NOT NULL and embed before insert.');
  }

  // -- 4. SPEC M1 exit criterion --------------------------------------------
  head('M1 exit criterion: embed two strings, store, retrieve the nearer one');

  const { FakeEmbeddingProvider } = await import('../dist/providers/embedding/fake.js');
  const embedder = new FakeEmbeddingProvider(1024);

  const corpus = [
    ['weather-heavy',  'resolved', 'Flight delayed 180 minutes by weather, 42 misconnecting passengers rebooked overnight'],
    ['crew-shortage',  'resolved', 'Flight cancelled due to crew shortage, 12 passengers rerouted via partner carrier'],
    ['unrelated',      'resolved', 'Routine catering inventory reconciliation for quarterly audit'],
    ['not-resolved',   'open',     'Flight delayed 175 minutes by weather, 39 misconnecting passengers awaiting rebooking'],
  ];

  const tableOk = (await attempt('SELECT 1 FROM _smoke_vec LIMIT 1')).ok;
  if (!tableOk) {
    fail('no usable _smoke_vec table; skipping retrieval test');
  } else {
    for (const [label, status, text] of corpus) {
      const vec = await embedder.embed(text);
      const r = await attempt(
        'INSERT INTO _smoke_vec (label, case_status, embedding) VALUES ($1, $2, $3)',
        [label, status, `[${vec.join(',')}]`],
      );
      if (!r.ok) { fail(`insert ${label}: ${r.error}`); }
    }
    info(`inserted ${corpus.length} rows`);

    // The query: hybrid structured + semantic. Filter on the prefix column,
    // rank by cosine distance. `<=>` must match vector_cosine_ops.
    const queryText = 'Flight delayed roughly three hours by storms, dozens of passengers missing connections';
    const qvec = await embedder.embed(queryText);

    const search = await attempt(
      `SELECT label, embedding <=> $1 AS distance
         FROM _smoke_vec
        WHERE case_status = 'resolved'
        ORDER BY embedding <=> $1
        LIMIT 3`,
      [`[${qvec.join(',')}]`],
    );

    if (!search.ok) {
      fail(`similarity query: ${search.error}`);
    } else {
      for (const row of search.rows) {
        info(`${row.label.padEnd(16)} distance ${Number(row.distance).toFixed(4)}`);
      }
      const winner = search.rows[0]?.label;
      findings.nearest = winner;
      if (winner === 'weather-heavy') {
        pass('nearest precedent is the weather case -- retrieval ranks correctly');
      } else {
        fail(`expected 'weather-heavy' nearest, got '${winner}'`);
      }
      const leaked = search.rows.some((r) => r.label === 'not-resolved');
      findings.filterWorks = !leaked;
      if (leaked) fail("the case_status='resolved' filter leaked an open case");
      else pass("hybrid filter held: no 'open' case in the results");
    }

    // -- 5. Is it actually index-accelerated? -------------------------------
    head('Is the similarity query index-accelerated?  (SPEC §5.1)');
    const plan = await attempt(
      `EXPLAIN SELECT label FROM _smoke_vec
        WHERE case_status = 'resolved'
        ORDER BY embedding <=> $1
        LIMIT 3`,
      [`[${qvec.join(',')}]`],
    );
    if (!plan.ok) {
      fail(`EXPLAIN failed: ${plan.error}`);
    } else {
      const text = plan.rows.map((r) => Object.values(r)[0]).join('\n');
      console.log(text.split('\n').map((l) => `        ${l}`).join('\n'));
      const usesVectorIndex = /vector\s*(index|search)|idx_smoke_status_vec/i.test(text);
      findings.indexAccelerated = usesVectorIndex;
      if (usesVectorIndex) pass('plan references the vector index');
      else fail('plan shows NO vector index -- retrieval would be a full scan');
    }
  }
} catch (err) {
  console.error('\nFATAL:', err.message);
  process.exitCode = 1;
} finally {
  head('Cleanup');
  await attempt('DROP TABLE IF EXISTS _smoke_vec');
  await attempt('DROP TABLE IF EXISTS _smoke_null');
  info('dropped _smoke_* tables');
  await client.end().catch(() => {});

  head('Summary');
  console.log(JSON.stringify(findings, null, 2));
}
