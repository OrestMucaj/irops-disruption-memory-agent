import type pg from 'pg';

import type { Config } from '../config.js';
import { toVectorLiteral } from '../db.js';
import type { EmbeddingProvider, LLMProvider } from '../providers/index.js';

import { SYSTEM_PROMPT, buildUserMessage } from './prompt.js';
import { retrievePrecedents } from './retrieval.js';
import type { Precedent } from './retrieval.js';
import {
  agentOutputSchema,
  extractJson,
  findCoverageGaps,
  groundActions,
} from './schema.js';
import type { GroundedAction } from './schema.js';

/**
 * The agent loop — SPEC §5.
 *
 * retrieve precedent -> reason -> validate -> persist proposals, with every run
 * recorded in `agent_runs` whether it succeeded or not.
 *
 * Guardrails this file is responsible for (SPEC §5.4):
 *
 *  - Nothing is ever executed. Proposals land with status 'proposed' and a
 *    human decides. That is enforced by the schema's CHECK constraints, not
 *    just by convention here.
 *  - Model calls are capped per run and individually timed out.
 *  - A malformed model response gets exactly one retry with the error fed back,
 *    then degrades to a visible error state. It never throws into the caller
 *    and never silently returns nothing.
 *  - Every run writes an `agent_runs` row, including failures. A failed run
 *    that leaves no trace is the observability equivalent of a silent catch.
 *  - Every query is parameterised.
 */

export interface AgentRunResult {
  readonly runId: string;
  readonly caseId: string;
  readonly actions: readonly GroundedAction[];
  readonly precedents: readonly Precedent[];
  readonly warnings: readonly string[];
  /** Passengers with a missed connection and no action to reaccommodate them. */
  readonly coverageGaps: readonly string[];
  readonly modelCalls: number;
  readonly latencyMs: number;
  /** Non-null when the run failed. The caller should surface this to the user. */
  readonly error: string | null;
}

export async function runAgent(
  pool: pg.Pool,
  embedder: EmbeddingProvider,
  llm: LLMProvider,
  config: Config,
  caseId: string,
): Promise<AgentRunResult> {
  const started = Date.now();
  const runId = await beginRun(pool, caseId, llm.modelId);

  const warnings: string[] = [];
  let coverageGaps: readonly string[] = [];
  let precedents: readonly Precedent[] = [];
  let modelCalls = 0;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;

  try {
    // --- Retrieve ---------------------------------------------------------
    const retrieval = await retrievePrecedents(pool, embedder, caseId, config.retrievalTopK);
    precedents = retrieval.precedents;

    const retrievedIds = new Set(precedents.map((p) => p.caseId));
    const knownPaxRefs = new Set(retrieval.passengers.map((p) => p.paxRef));

    if (precedents.length === 0) {
      warnings.push('no precedents found; proposals rest on case facts alone');
    }

    // --- Reason -----------------------------------------------------------
    const userMessage = buildUserMessage(retrieval.subject, retrieval.passengers, precedents);

    let actions: GroundedAction[] = [];
    let lastError: string | null = null;
    const maxAttempts = Math.min(2, Math.max(1, config.maxModelCallsPerCase));

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const message = attempt === 1
        ? userMessage
        : `${userMessage}\n\nYour previous response could not be used: ${lastError}\nRespond with the JSON object only.`;

      modelCalls += 1;
      const completion = await withTimeout(
        llm.complete({ system: SYSTEM_PROMPT, user: message, temperature: 0 }),
        config.modelTimeoutMs,
        'model call',
      );

      promptTokens = completion.promptTokens;
      completionTokens = completion.completionTokens;

      const parsed = extractJson(completion.text);
      if (parsed === null) {
        lastError = 'response was not valid JSON';
        warnings.push(`attempt ${attempt}: ${lastError}`);
        continue;
      }

      const validated = agentOutputSchema.safeParse(parsed);
      if (!validated.success) {
        lastError = validated.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        warnings.push(`attempt ${attempt}: schema validation failed - ${lastError}`);
        continue;
      }

      // Shape is fine. Now check it only refers to things that exist.
      const grounded = groundActions(validated.data.actions, { retrievedCaseIds: retrievedIds, knownPaxRefs });
      warnings.push(...grounded.warnings);
      actions = grounded.actions;
      lastError = null;
      break;
    }

    if (lastError !== null) {
      const message = `model did not return usable output after ${modelCalls} attempt(s): ${lastError}`;
      await finishRun(pool, runId, {
        promptTokens, completionTokens,
        latencyMs: Date.now() - started,
        retrievedCaseIds: [...retrievedIds],
        error: message,
      });
      return {
        runId, caseId, actions: [], precedents, warnings, coverageGaps,
        modelCalls, latencyMs: Date.now() - started, error: message,
      };
    }

    // Invariant check, not a model instruction. See findCoverageGaps.
    coverageGaps = findCoverageGaps(actions, retrieval.passengers);
    if (coverageGaps.length > 0) {
      warnings.push(
        `${coverageGaps.length} passenger(s) have already missed their connection but have ` +
          `no action to reaccommodate them: ${coverageGaps.join(', ')}`,
      );
    }

    // --- Persist ----------------------------------------------------------
    await persist(pool, {
      runId,
      caseId,
      subjectStatus: retrieval.subject.status,
      summaryText: retrieval.summaryText,
      embedding: retrieval.embedding,
      modelId: embedder.modelId,
      actions,
    });

    await finishRun(pool, runId, {
      promptTokens, completionTokens,
      latencyMs: Date.now() - started,
      retrievedCaseIds: [...retrievedIds],
      error: null,
    });

    return {
      runId, caseId, actions, precedents, warnings, coverageGaps,
      modelCalls, latencyMs: Date.now() - started, error: null,
    };
  } catch (err) {
    // Anything unexpected -- retrieval failure, database error, model timeout.
    // Record it and hand back a result rather than throwing: SPEC §5.2 requires
    // a visible error state, not a crash.
    const message = err instanceof Error ? err.message : String(err);
    await finishRun(pool, runId, {
      promptTokens, completionTokens,
      latencyMs: Date.now() - started,
      retrievedCaseIds: precedents.map((p) => p.caseId),
      error: message,
    }).catch(() => { /* the original error matters more than this one */ });

    return {
      runId, caseId, actions: [], precedents, warnings, coverageGaps,
      modelCalls, latencyMs: Date.now() - started, error: message,
    };
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface PersistInput {
  runId: string;
  caseId: string;
  subjectStatus: string;
  summaryText: string;
  embedding: readonly number[];
  modelId: string;
  actions: readonly GroundedAction[];
}

async function persist(pool: pg.Pool, input: PersistInput): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Keep the case's own memory current. If the case facts changed since it
    // was last embedded, the stored vector is stale and would retrieve badly
    // once this case itself becomes precedent.
    //
    // case_status is written from the case row in the same statement, so the
    // denormalized index prefix cannot drift (NOTES.md §1.3).
    await client.query(
      `INSERT INTO case_embeddings (case_id, summary_text, case_status, embedding, model_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (case_id) DO UPDATE
         SET summary_text = excluded.summary_text,
             case_status  = excluded.case_status,
             embedding    = excluded.embedding,
             model_id     = excluded.model_id,
             embedded_at  = now()`,
      [
        input.caseId,
        input.summaryText,
        input.subjectStatus,
        toVectorLiteral(input.embedding),
        input.modelId,
      ],
    );

    // Clear still-undecided proposals from earlier runs on this case.
    //
    // Re-running otherwise stacks a second plan on top of the first, producing
    // duplicate and sometimes contradictory actions with nothing to say which
    // run each came from. An undecided proposal that a fresh run has superseded
    // is stale noise, not history.
    //
    // Decided actions are deliberately untouched. Approved, edited and rejected
    // are human decisions and are exactly the memory SPEC §5.3 wants kept --
    // deleting a rejection to tidy the list would erase the most informative
    // signal in the system.
    await client.query(
      `DELETE FROM proposed_actions WHERE case_id = $1 AND status = 'proposed'`,
      [input.caseId],
    );

    for (const action of input.actions) {
      await client.query(
        `INSERT INTO proposed_actions (
           case_id, agent_run_id, action_type, target_pax_ref, payload,
           rationale, precedent_case_ids, confidence, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'proposed')`,
        [
          input.caseId,
          input.runId,
          action.action_type,
          action.target_pax_ref,
          JSON.stringify(action.payload),
          action.rationale,
          action.precedent_case_ids,
          action.confidence,
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

// ---------------------------------------------------------------------------
// agent_runs bookkeeping
// ---------------------------------------------------------------------------

/**
 * Opens the run row before any work happens.
 *
 * Written up front rather than at the end so that a process killed mid-run
 * still leaves evidence: a row with no latency and no error is a run that
 * started and never came back, which is exactly the failure you most want to
 * be able to see.
 */
async function beginRun(pool: pg.Pool, caseId: string, modelId: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO agent_runs (case_id, model_id) VALUES ($1, $2) RETURNING id::STRING AS id`,
    [caseId, modelId],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('failed to open an agent_runs row');
  return String(id);
}

interface FinishInput {
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
  retrievedCaseIds: readonly string[];
  error: string | null;
}

async function finishRun(pool: pg.Pool, runId: string, input: FinishInput): Promise<void> {
  await pool.query(
    `UPDATE agent_runs
        SET prompt_tokens = $2, completion_tokens = $3, latency_ms = $4,
            retrieved_case_ids = $5, error = $6
      WHERE id = $1`,
    [
      runId,
      input.promptTokens,
      input.completionTokens,
      input.latencyMs,
      input.retrievedCaseIds,
      input.error,
    ],
  );
}

// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
