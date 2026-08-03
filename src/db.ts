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
