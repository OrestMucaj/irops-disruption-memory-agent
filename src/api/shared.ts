import { loadConfig } from '../config.js';
import { checkEmbeddingModelConsistency, createPool } from '../db.js';
import { createEmbeddingProvider, createLLMProvider } from '../providers/index.js';

import type { ApiDeps } from './router.js';

/**
 * Dependency construction, shared by the local server and the Lambda.
 *
 * Built once per process, not per request. On Lambda that means the connection
 * pool survives across warm invocations — creating a pool per request would
 * open a new TLS connection to CockroachDB every time and dominate latency.
 */
let cached: ApiDeps | null = null;

export function getDeps(): ApiDeps {
  if (cached !== null) return cached;

  const config = loadConfig();
  cached = {
    config,
    pool: createPool(config),
    embedder: createEmbeddingProvider(config),
    llm: createLLMProvider(config),
  };
  return cached;
}

/**
 * One-time startup check for the embedding-model mismatch described in db.ts.
 * Logged rather than thrown: a Lambda that refuses to start is harder to
 * diagnose than one that answers /api/health with a loud complaint.
 */
export async function warnOnModelMismatch(deps: ApiDeps): Promise<void> {
  try {
    const mismatch = await checkEmbeddingModelConsistency(deps.pool, deps.embedder.modelId);
    if (mismatch !== null) {
      console.error(`[startup] EMBEDDING MODEL MISMATCH: ${mismatch}`);
    }
  } catch (err) {
    console.error(`[startup] could not check embedding consistency: ${String(err)}`);
  }
}

/**
 * CORS headers.
 *
 * Wide open, deliberately. The frontend is served from an S3 origin and the API
 * from a Lambda Function URL, so they are always cross-origin. Restricting this
 * would protect nothing: the API is intentionally public so judges can use the
 * demo without credentials (SPEC §7), and CORS is not an authorization
 * mechanism. The real controls are elsewhere -- no action is ever auto-executed,
 * every write is parameterised and validated, and the MCP path is read-only.
 *
 * Documented in the README so this reads as a decision rather than an oversight.
 */
export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};
