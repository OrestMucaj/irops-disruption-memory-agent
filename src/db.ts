import pg from 'pg';

import type { Config } from './config.js';

/**
 * Connection pooling for CockroachDB.
 *
 * CockroachDB speaks the PostgreSQL wire protocol, so `pg` works unmodified --
 * which is a large part of why SPEC §3 chose it over a bespoke driver.
 *
 * Timeouts come from config rather than being hardcoded because SPEC §5.4
 * requires bounded database calls: an agent that hangs on a slow query is worse
 * than one that fails, since the human at the IROPS desk is waiting on it.
 */
export function createPool(config: Config): pg.Pool {
  if (config.databaseUrl === null) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and fill it in, then ' +
        'run with: node --env-file=.env <script>',
    );
  }

  return new pg.Pool({
    connectionString: config.databaseUrl,
    // CockroachDB Cloud presents a publicly-trusted certificate, so the system
    // trust store is enough and there is no cert file to ship. Do NOT relax
    // this to rejectUnauthorized:false -- verify-full is in the connection
    // string for a reason.
    ssl: { rejectUnauthorized: true },
    statement_timeout: config.dbTimeoutMs,
    query_timeout: config.dbTimeoutMs,
    connectionTimeoutMillis: Math.max(config.dbTimeoutMs, 15_000),
    max: 5,
  });
}

/** Formats a vector for a `VECTOR(n)` column: pg sends it as a string literal. */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * Refuses to query with an embedding model different from the one that wrote
 * the stored vectors.
 *
 * This is the sharpest footgun in the whole system. Vectors from two different
 * models occupy unrelated spaces, so comparing them returns confident, ordered,
 * completely meaningless results. Nothing errors. The distances look plausible.
 * Retrieval quality just silently collapses to noise, and every downstream
 * claim built on it becomes false.
 *
 * It is precisely what happens the first time you flip EMBEDDING_PROVIDER from
 * `fake` to `bedrock` against an already-seeded database — which is why
 * `case_embeddings.model_id` exists and why this check is cheap insurance.
 *
 * Returns a description of the mismatch, or null when everything agrees.
 */
export async function checkEmbeddingModelConsistency(
  db: pg.Pool,
  currentModelId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ model_id: string; n: string }>(
    `SELECT model_id, count(*)::STRING AS n
       FROM case_embeddings
      GROUP BY model_id
      ORDER BY count(*) DESC`,
  );

  if (rows.length === 0) return null;

  const foreign = rows.filter((r) => r.model_id !== currentModelId);
  if (foreign.length === 0) return null;

  const stored = rows.map((r) => `${r.model_id} (${r.n} rows)`).join(', ');
  return (
    `stored embeddings were produced by ${stored}, but the configured provider is ` +
    `"${currentModelId}". Vectors from different models are not comparable, so ` +
    'retrieval would return confident nonsense. Re-embed everything with: ' +
    'npm run seed -- --reset'
  );
}
