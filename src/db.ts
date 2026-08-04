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

/**
 * Runs a transaction, retrying serialization failures with exponential backoff
 * and jitter.
 *
 * Added 2026-08-04 after applying the CockroachDB Agent Skill
 * `designing-application-transactions`, which flagged this as a required
 * pattern we did not have. Its guidance, verbatim: "Always implement retry
 * logic for `40001` serialization errors."
 *
 * Why it matters here rather than in the abstract: CockroachDB defaults to
 * SERIALIZABLE isolation, the strictest level, and resolves write conflicts by
 * aborting one side with SQLSTATE `40001` and expecting the client to try
 * again. Every explicit transaction in this app touches rows another request
 * could touch at the same moment — resolving a case writes `disruption_cases`
 * and `case_embeddings` together; an agent run upserts `case_embeddings` for a
 * case someone else may be resolving. Two judges clicking at once during the
 * judging window is enough. Without this the loser of that race saw a raw
 * database error.
 *
 * What is deliberately NOT retried:
 *  - `40003` ambiguous commit. The write may already have landed, and this
 *    app's transactions are not idempotent — replaying could double-insert a
 *    resolution. Surfacing it is correct.
 *  - `23xxx` constraint violations. A CHECK or FK rejection is a bug or a bad
 *    request; retrying just fails again more slowly.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
  options: { maxAttempts?: number; label?: string } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  let backoffMs = 100;

  for (let attempt = 1; ; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => { /* the original error wins */ });

      const code = (err as { code?: string }).code;
      if (code !== '40001' || attempt >= maxAttempts) throw err;

      // Jitter matters: without it, contending clients retry in lockstep and
      // collide again on exactly the same schedule.
      const wait = backoffMs + Math.random() * 100;
      console.warn(
        `[db] serialization failure${options.label === undefined ? '' : ` in ${options.label}`}` +
          ` (attempt ${attempt}/${maxAttempts}), retrying in ${Math.round(wait)}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
      backoffMs = Math.min(backoffMs * 2, 2000);
    } finally {
      client.release();
    }
  }
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
