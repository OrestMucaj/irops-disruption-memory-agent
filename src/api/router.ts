import { z } from 'zod';
import type pg from 'pg';

import type { Config } from '../config.js';
import { toVectorLiteral } from '../db.js';
import { buildResolutionSummary } from '../domain/summary.js';
import { runAgent } from '../agent/run.js';
import { loadCase } from '../agent/retrieval.js';
import type { EmbeddingProvider, LLMProvider } from '../providers/index.js';

/**
 * HTTP API, deliberately transport-agnostic.
 *
 * Takes a method, a path and a parsed body; returns a status and a JSON value.
 * It knows nothing about node:http or about Lambda. Both adapters are thin
 * shims over this one function, so "it works locally" is actually evidence
 * about the deployed demo rather than a separate code path that happens to
 * behave similarly.
 *
 * Two cost decisions baked in (SPEC §5.4, NOTES §3.2, §6.3):
 *
 *  - **No embedding on page load.** Reading a case returns the precedents from
 *    its last agent run, resolved through `agent_runs.retrieved_case_ids`.
 *    Re-embedding on every GET would spend Bedrock calls and CockroachDB
 *    Request Units on people merely browsing, and the demo has to survive a
 *    month of judging on a free tier.
 *  - **The agent runs only when asked**, via an explicit POST.
 */

export interface ApiDeps {
  readonly pool: pg.Pool;
  readonly embedder: EmbeddingProvider;
  readonly llm: LLMProvider;
  readonly config: Config;
}

export interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const badRequest = (message: string, detail?: unknown): ApiResponse => ({
  status: 400,
  body: { error: message, detail },
});
const notFound = (message: string): ApiResponse => ({ status: 404, body: { error: message } });

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handle(deps: ApiDeps, request: ApiRequest): Promise<ApiResponse> {
  const { method, path } = request;
  const segments = path.replace(/^\/+|\/+$/g, '').split('/');

  // /health
  if (method === 'GET' && path === '/api/health') {
    return handleHealth(deps);
  }

  // /api/cases
  if (method === 'GET' && path === '/api/cases') {
    return listCases(deps, request.query.status ?? 'all');
  }

  // /api/memory
  if (method === 'GET' && path === '/api/memory') {
    return memoryView(deps);
  }

  // /api/cases/:id  and  /api/cases/:id/{run,resolve}
  if (segments[0] === 'api' && segments[1] === 'cases' && segments[2] !== undefined) {
    const caseId = segments[2];
    if (!uuidRe.test(caseId)) return badRequest('case id must be a UUID');

    if (method === 'GET' && segments[3] === undefined) return caseDetail(deps, caseId);
    if (method === 'POST' && segments[3] === 'run') return runAgentRoute(deps, caseId);
    if (method === 'POST' && segments[3] === 'resolve') return resolveCase(deps, caseId, request.body);
  }

  // /api/actions/:id/decision
  if (
    method === 'POST' && segments[0] === 'api' && segments[1] === 'actions'
    && segments[2] !== undefined && segments[3] === 'decision'
  ) {
    const actionId = segments[2];
    if (!uuidRe.test(actionId)) return badRequest('action id must be a UUID');
    return decideAction(deps, actionId, request.body);
  }

  return notFound(`no route for ${method} ${path}`);
}

// ---------------------------------------------------------------------------

async function handleHealth(deps: ApiDeps): Promise<ApiResponse> {
  try {
    await deps.pool.query('SELECT 1');
    return ok({
      status: 'ok',
      embeddingProvider: deps.embedder.name,
      embeddingModel: deps.embedder.modelId,
      llmProvider: deps.llm.name,
      llmModel: deps.llm.modelId,
    });
  } catch (err) {
    return {
      status: 503,
      body: { status: 'degraded', error: err instanceof Error ? err.message : String(err) },
    };
  }
}

async function listCases(deps: ApiDeps, status: string): Promise<ApiResponse> {
  const filter = ['open', 'planned', 'resolved'].includes(status) ? status : null;

  const { rows } = await deps.pool.query(
    `SELECT c.id::STRING AS id, c.flight_no, c.origin, c.destination,
            c.scheduled_dep, c.delay_minutes, c.cause, c.status,
            c.pax_count, c.misconnect_count, c.priority_pax_count,
            r.outcome_rating,
            (SELECT count(*)::INT FROM proposed_actions a
              WHERE a.case_id = c.id AND a.status = 'proposed') AS pending_actions
       FROM disruption_cases c
       LEFT JOIN resolutions r ON r.case_id = c.id
      WHERE ($1::STRING IS NULL OR c.status = $1)
      ORDER BY
        CASE c.status WHEN 'open' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END,
        c.scheduled_dep DESC
      LIMIT 200`,
    [filter],
  );

  return ok({ cases: rows });
}

async function caseDetail(deps: ApiDeps, caseId: string): Promise<ApiResponse> {
  const loaded = await loadCase(deps.pool, caseId);
  if (loaded === null) return notFound(`case ${caseId} not found`);

  const [actions, lastRun, resolution] = await Promise.all([
    deps.pool.query(
      `SELECT id::STRING AS id, action_type, target_pax_ref, payload, edited_payload,
              rationale, precedent_case_ids::STRING[] AS precedent_case_ids,
              confidence, status, created_at, decided_at
         FROM proposed_actions
        WHERE case_id = $1
        ORDER BY created_at DESC, action_type`,
      [caseId],
    ),
    deps.pool.query(
      `SELECT id::STRING AS id, model_id, prompt_tokens, completion_tokens, latency_ms,
              retrieved_case_ids::STRING[] AS retrieved_case_ids, error, created_at
         FROM agent_runs
        WHERE case_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [caseId],
    ),
    deps.pool.query(
      `SELECT actions_taken, outcome_notes, outcome_rating, resolved_at
         FROM resolutions WHERE case_id = $1`,
      [caseId],
    ),
  ]);

  // Precedents come from the last run, not a fresh vector search. See the note
  // at the top of this file.
  const retrievedIds: string[] = lastRun.rows[0]?.retrieved_case_ids ?? [];
  let precedents: unknown[] = [];

  if (retrievedIds.length > 0) {
    const { rows } = await deps.pool.query(
      `SELECT c.id::STRING AS id, c.flight_no, c.cause, c.delay_minutes,
              c.scheduled_dep, c.origin, c.destination,
              e.summary_text,
              r.actions_taken, r.outcome_notes, r.outcome_rating, r.resolved_at
         FROM disruption_cases c
         JOIN case_embeddings e ON e.case_id = c.id
         LEFT JOIN resolutions r ON r.case_id = c.id
        WHERE c.id = ANY($1::UUID[])`,
      [retrievedIds],
    );
    // Preserve retrieval order (closest first); SQL gives no ordering guarantee.
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    precedents = retrievedIds.map((id) => byId.get(id)).filter((r) => r !== undefined);
  }

  return ok({
    case: loaded.subject,
    passengers: loaded.passengers,
    actions: actions.rows,
    precedents,
    lastRun: lastRun.rows[0] ?? null,
    resolution: resolution.rows[0] ?? null,
  });
}

async function runAgentRoute(deps: ApiDeps, caseId: string): Promise<ApiResponse> {
  const result = await runAgent(deps.pool, deps.embedder, deps.llm, deps.config, caseId);

  // A failed run is a 200 with an error field, not a 5xx. SPEC §5.2 wants a
  // visible error state in the UI; a 500 would surface as a browser console
  // message and an empty panel, which is exactly the "silently show nothing"
  // failure it forbids.
  return ok({
    runId: result.runId,
    error: result.error,
    warnings: result.warnings,
    modelCalls: result.modelCalls,
    latencyMs: result.latencyMs,
    actionCount: result.actions.length,
    precedentCount: result.precedents.length,
  });
}

const decisionSchema = z.object({
  status: z.enum(['approved', 'rejected', 'edited']),
  edited_payload: z.record(z.unknown()).optional(),
});

async function decideAction(deps: ApiDeps, actionId: string, body: unknown): Promise<ApiResponse> {
  const parsed = decisionSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('invalid decision', parsed.error.issues);
  }

  const { status, edited_payload: editedPayload } = parsed.data;

  // The CHECK constraint requires edited_payload exactly when status='edited'.
  // Enforced here too so the caller gets a useful message instead of a raw
  // constraint violation.
  if (status === 'edited' && editedPayload === undefined) {
    return badRequest("status 'edited' requires an edited_payload");
  }
  if (status !== 'edited' && editedPayload !== undefined) {
    return badRequest("edited_payload is only valid with status 'edited'");
  }

  const { rows } = await deps.pool.query(
    `UPDATE proposed_actions
        SET status = $2,
            edited_payload = $3,
            decided_at = now()
      WHERE id = $1 AND status = 'proposed'
      RETURNING id::STRING AS id, status, decided_at`,
    [actionId, status, editedPayload === undefined ? null : JSON.stringify(editedPayload)],
  );

  const row = rows[0];
  if (row === undefined) {
    // Either it does not exist or it was already decided. Both are 409-ish;
    // re-deciding must not silently overwrite a recorded human decision.
    return { status: 409, body: { error: 'action not found, or already decided' } };
  }

  return ok(row);
}

const resolveSchema = z.object({
  outcome_notes: z.string().min(1).max(2000),
  outcome_rating: z.number().int().min(1).max(5),
});

/**
 * Closes a case: writes the resolution, embeds it, and flips the case to
 * resolved — making it retrievable precedent for every future disruption.
 *
 * This is the loop closing, and the moment the demo needs to make visible.
 *
 * Everything below happens in ONE transaction: the resolution row, its
 * embedding, the case status, and the denormalized `case_embeddings.case_status`
 * that the vector index uses as its prefix. That is the SPEC §4 claim in
 * practice — no ETL, no window where the agent's memory disagrees with what
 * actually happened.
 */
async function resolveCase(deps: ApiDeps, caseId: string, body: unknown): Promise<ApiResponse> {
  const parsed = resolveSchema.safeParse(body);
  if (!parsed.success) return badRequest('invalid resolution', parsed.error.issues);

  const loaded = await loadCase(deps.pool, caseId);
  if (loaded === null) return notFound(`case ${caseId} not found`);
  if (loaded.subject.status === 'resolved') {
    return { status: 409, body: { error: 'case is already resolved' } };
  }

  // Approved and edited actions are what was actually done. Rejected ones are
  // deliberately excluded from actions_taken but remain in proposed_actions --
  // SPEC §5.3: what a human overruled is memory too.
  const { rows: decided } = await deps.pool.query(
    `SELECT action_type, target_pax_ref, status, coalesce(edited_payload, payload) AS payload
       FROM proposed_actions
      WHERE case_id = $1 AND status IN ('approved', 'edited')`,
    [caseId],
  );

  const actionsTaken = decided.map((a) => ({
    action_type: String(a.action_type),
    affected_pax: a.target_pax_ref === null ? loaded.subject.paxCount : 1,
    detail: `${String(a.status)} by reviewer`,
  }));

  const resolutionSummary = buildResolutionSummary(loaded.subject, {
    actionsTaken: actionsTaken.map((a) => ({
      action_type: a.action_type as never,
      affected_pax: a.affected_pax,
    })),
    outcomeNotes: parsed.data.outcome_notes,
    outcomeRating: parsed.data.outcome_rating,
  });

  // Embed before opening the transaction: a model call is slow and can fail,
  // and holding a write transaction across it would be a pointless lock.
  let embedding: number[] | null = null;
  try {
    embedding = await deps.embedder.embed(resolutionSummary);
  } catch {
    // resolutions.embedding is nullable precisely for this: recording that a
    // case was resolved must not fail because Bedrock was unavailable. The row
    // is written unembedded and backfilled later.
    embedding = null;
  }

  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO resolutions (case_id, actions_taken, outcome_notes, outcome_rating, embedding, model_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        caseId,
        JSON.stringify(actionsTaken),
        parsed.data.outcome_notes,
        parsed.data.outcome_rating,
        embedding === null ? null : toVectorLiteral(embedding),
        embedding === null ? null : deps.embedder.modelId,
      ],
    );

    await client.query(`UPDATE disruption_cases SET status = 'resolved' WHERE id = $1`, [caseId]);

    // Must move in lockstep with the line above, or the vector index prefix
    // stops matching reality and this case never surfaces as precedent.
    await client.query(
      `UPDATE case_embeddings SET case_status = 'resolved' WHERE case_id = $1`,
      [caseId],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return ok({
    caseId,
    resolved: true,
    embedded: embedding !== null,
    actionsRecorded: actionsTaken.length,
  });
}

/**
 * The memory view (SPEC §6.3) — what the agent has actually learned.
 *
 * Exists so the demo video can show the memory layer rather than assert it.
 */
async function memoryView(deps: ApiDeps): Promise<ApiResponse> {
  const [recent, mostCited, stats, runs] = await Promise.all([
    deps.pool.query(
      `SELECT c.id::STRING AS id, c.flight_no, c.cause, c.delay_minutes,
              r.outcome_rating, r.outcome_notes, r.resolved_at,
              r.embedding IS NOT NULL AS embedded
         FROM resolutions r
         JOIN disruption_cases c ON c.id = r.case_id
        ORDER BY r.resolved_at DESC
        LIMIT 12`,
    ),
    // Which precedents the agent actually leans on, counted across every
    // proposal it has ever made.
    // Unnest in a CTE rather than a comma-join. CockroachDB scopes the alias of
    // a comma-joined set-returning function differently from an explicit JOIN,
    // and mixing the two fails with "no data source matches prefix".
    deps.pool.query(
      `WITH citations AS (
         SELECT unnest(precedent_case_ids) AS case_id FROM proposed_actions
       )
       SELECT c.id::STRING AS id, count(*)::INT AS citations,
              c.flight_no, c.cause, c.delay_minutes, r.outcome_rating
         FROM citations ct
         JOIN disruption_cases c ON c.id = ct.case_id
         LEFT JOIN resolutions r ON r.case_id = c.id
        GROUP BY c.id, c.flight_no, c.cause, c.delay_minutes, r.outcome_rating
        ORDER BY count(*) DESC
        LIMIT 10`,
    ),
    deps.pool.query(
      `SELECT
         (SELECT count(*)::INT FROM disruption_cases) AS total_cases,
         (SELECT count(*)::INT FROM disruption_cases WHERE status = 'resolved') AS resolved_cases,
         (SELECT count(*)::INT FROM case_embeddings) AS embedded_cases,
         (SELECT count(*)::INT FROM resolutions WHERE embedding IS NOT NULL) AS embedded_resolutions,
         (SELECT count(*)::INT FROM proposed_actions) AS total_proposals,
         (SELECT count(*)::INT FROM proposed_actions WHERE status = 'approved') AS approved,
         (SELECT count(*)::INT FROM proposed_actions WHERE status = 'rejected') AS rejected,
         (SELECT count(*)::INT FROM proposed_actions WHERE status = 'edited') AS edited`,
    ),
    deps.pool.query(
      `SELECT id::STRING AS id, case_id::STRING AS case_id, model_id,
              prompt_tokens, completion_tokens, latency_ms, error, created_at
         FROM agent_runs ORDER BY created_at DESC LIMIT 10`,
    ),
  ]);

  return ok({
    recentResolutions: recent.rows,
    mostCitedPrecedents: mostCited.rows,
    stats: stats.rows[0] ?? {},
    recentRuns: runs.rows,
  });
}
