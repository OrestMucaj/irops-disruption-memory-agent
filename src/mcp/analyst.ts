import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { ContentBlock, Message, Tool } from '@aws-sdk/client-bedrock-runtime';
import type pg from 'pg';

import type { Config } from '../config.js';

import { McpClient, McpError } from './client.js';

/**
 * The read-only analyst — SPEC §7's MCP option (a).
 *
 * An ops lead asks a question in English; the model answers it by writing SQL
 * and running it against the memory layer through the CockroachDB Cloud
 * Managed MCP Server.
 *
 * ─── WHY THIS PATH EXISTS SEPARATELY FROM THE AGENT LOOP ───
 *
 * The agent loop's SQL is fixed, parameterised, and written by hand; the model
 * only ever emits JSON *proposals* and application code decides what runs. That
 * is why the `pg` connection can safely hold read-write credentials.
 *
 * Here the model writes the SQL. That is a categorically different risk, so it
 * never touches the `pg` connection. It goes through MCP, which is a governed
 * gateway: per-call RBAC, one statement per call, a 20-second timeout, a 10 KiB
 * response cap, and system schemas blocked (NOTES.md §2.5).
 *
 * ─── HOW READ-ONLY IS ACTUALLY ENFORCED ───
 *
 * Not by the credential. Verified against the live server (NOTES.md §2.6): the
 * platform requires a service account to hold Cluster Operator or Admin — there
 * is no read-only role — so `insert_rows`, `create_table` and `create_database`
 * ARE offered to our key whether we want them or not.
 *
 * Read-only is therefore a property of THIS FILE. `ALLOWED_TOOLS` is the
 * enforcement boundary, checked below before every dispatch. A tool outside it
 * is refused even if the model asks and even if the server would honour it.
 * This is load-bearing security, not documentation.
 */

/** The only tools this analyst may ever invoke. Enforcement, not preference. */
const ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'select_query',
  'get_table_schema',
  'list_tables',
]);

/** Tables the analyst may read. Narrower than the schema on purpose. */
const READABLE_TABLES = [
  'disruption_cases',
  'passengers',
  'case_embeddings',
  'resolutions',
  'proposed_actions',
  'agent_runs',
] as const;

/** Model round trips per question. Bounds cost and stops a loop from spinning. */
const MAX_TURNS = 6;

const DATABASE = 'defaultdb';

export interface AnalystQuery {
  readonly tool: string;
  readonly sql: string | null;
  readonly ok: boolean;
  readonly detail: string;
  readonly ms: number;
  /**
   * The rows the query actually returned, truncated for display.
   *
   * Returned to the caller on purpose. Observed 2026-08-04: asked which cause
   * had the WORST average outcome, the model wrote a correct query, ordered it
   * `DESC`, then read the top row — reporting the best cause as the worst
   * (technical 3.89 instead of weather 3.42). The SQL was right; the reading of
   * it was not.
   *
   * A prompt rule makes that less likely (see SYSTEM), but nothing makes a
   * model's arithmetic reliable. Showing the rows makes the answer *checkable*
   * — the ops lead sees 3.42 next to 3.89 and catches the reversal in a glance.
   * Same principle as the agent loop's precedent panel: the model supplies
   * judgement, the human can always see the evidence.
   */
  readonly result: string | null;
}

export interface AnalystResult {
  readonly answer: string | null;
  readonly queries: readonly AnalystQuery[];
  readonly turns: number;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly latencyMs: number;
  readonly refusals: readonly string[];
  readonly error: string | null;
}

const SYSTEM = `You are a read-only analyst for an airline irregular-operations (IROPS) memory system. You answer an operations lead's questions about the disruption history by querying the database.

You have read-only tools. Use them; never answer a factual question from assumption when a query would settle it.

THE SCHEMA
- disruption_cases(id, flight_no, origin, destination, scheduled_dep, actual_dep, delay_minutes, cause, aircraft_type, pax_count, misconnect_count, priority_pax_count, status, created_at)
    cause: weather | technical | crew | atc | knock_on
    status: open | planned | resolved
- passengers(id, case_id, pax_ref, priority_tier, onward_flight, connection_minutes, connection_status, rebooked_to, special_handling)
    connection_status: safe | at_risk | missed
- resolutions(id, case_id, actions_taken JSONB, outcome_notes, outcome_rating 1-5, resolved_at, embedding, model_id)
- proposed_actions(id, case_id, agent_run_id, action_type, target_pax_ref, payload, edited_payload, rationale, precedent_case_ids UUID[], confidence, status, created_at, decided_at)
    action_type: rebook | prioritise | hotel | notify | escalate
    status: proposed | approved | rejected | edited
- case_embeddings(case_id, summary_text, case_status, embedding, model_id, embedded_at)
- agent_runs(id, case_id, model_id, prompt_tokens, completion_tokens, latency_ms, retrieved_case_ids UUID[], error, created_at)

RULES
1. Always pass database "${DATABASE}".
2. SELECT only. Always include an explicit LIMIT — 200 at most. Responses are capped at 10 KiB, so aggregate rather than dumping rows.
3. One statement per call. No semicolon-chaining, no CTE that writes.
4. Never query system, crdb_internal, pg_catalog or information_schema — they are blocked.
5. Prefer aggregates (count, avg, percentiles, GROUP BY) over row dumps. An ops lead wants the shape of the answer, not 200 rows.
6. Do not select the embedding columns. They are 1024-dimension vectors and will blow the response cap.
7. You may run several queries to build an answer. When you have enough, stop and answer.

SUPERLATIVES — READ THIS TWICE
When the question asks for a "worst", "best", "highest", "lowest", "most" or "least", the ORDER BY direction decides which row answers it. Getting this backwards is the single most common way to produce a confident wrong answer.
- worst / lowest / least  →  ORDER BY <measure> ASC   — the answer is the FIRST row
- best / highest / most   →  ORDER BY <measure> DESC  — the answer is the FIRST row
Order so that the row you want is first, then read the first row. Before answering, re-read the returned rows and confirm the value you are about to quote really is the extreme one in the direction asked.

ANSWERING
Be concise and concrete. Lead with the number or the finding. Quote the figures you actually retrieved. If the data does not support an answer, say so — never invent one. Two or three sentences is usually right.
Output the answer as plain prose only. Do not emit reasoning tags, XML, or markup of any kind.`;

export function analystAvailable(config: Config): boolean {
  return config.mcpApiKey !== null && config.mcpClusterId !== null;
}

/** Bedrock tool definitions, mirroring the MCP tools we allow. */
function toolConfig(): Tool[] {
  return [
    {
      toolSpec: {
        name: 'select_query',
        description:
          'Run a single read-only SELECT against the IROPS memory database and return the rows as JSON. Always include an explicit LIMIT.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'One SELECT statement. No semicolons, no DDL, no DML.',
              },
            },
            required: ['query'],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'get_table_schema',
        description: 'Return the CREATE TABLE statement for one table, to check exact column names and types.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              table: { type: 'string', description: `One of: ${READABLE_TABLES.join(', ')}` },
            },
            required: ['table'],
          },
        },
      },
    },
  ];
}

export async function runAnalyst(
  pool: pg.Pool,
  config: Config,
  question: string,
): Promise<AnalystResult> {
  const started = Date.now();
  const queries: AnalystQuery[] = [];
  const refusals: string[] = [];
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let turns = 0;

  if (config.mcpApiKey === null || config.mcpClusterId === null) {
    return {
      answer: null, queries, turns, promptTokens, completionTokens,
      latencyMs: Date.now() - started, refusals,
      error: 'the analyst is not configured — MCP_API_KEY and MCP_CLUSTER_ID are unset',
    };
  }
  if (config.bedrockLlmModelId === null) {
    return {
      answer: null, queries, turns, promptTokens, completionTokens,
      latencyMs: Date.now() - started, refusals,
      error: 'the analyst needs a Bedrock reasoning model (BEDROCK_LLM_MODEL_ID)',
    };
  }

  const mcp = new McpClient({
    url: config.mcpUrl,
    apiKey: config.mcpApiKey,
    clusterId: config.mcpClusterId,
    timeoutMs: Math.min(config.modelTimeoutMs, 25_000),
  });
  const bedrock = new BedrockRuntimeClient({ region: config.awsRegion, maxAttempts: 3 });

  // Logged like any other agent activity (SPEC §5.4) — including failures.
  const runId = await beginRun(pool, config.bedrockLlmModelId);

  const messages: Message[] = [{ role: 'user', content: [{ text: question }] }];
  let answer: string | null = null;
  let failure: string | null = null;

  try {
    await mcp.connect();

    for (turns = 1; turns <= MAX_TURNS; turns += 1) {
      const response = await bedrock.send(new ConverseCommand({
        modelId: config.bedrockLlmModelId,
        system: [{ text: SYSTEM }],
        messages,
        toolConfig: { tools: toolConfig() },
        inferenceConfig: { maxTokens: 2000, temperature: 0 },
      }));

      promptTokens = response.usage?.inputTokens ?? promptTokens;
      completionTokens = response.usage?.outputTokens ?? completionTokens;

      const reply = response.output?.message;
      if (reply === undefined) { failure = 'model returned no message'; break; }
      messages.push(reply);

      if (response.stopReason !== 'tool_use') {
        answer = stripReasoningMarkup((reply.content ?? [])
          .map((c) => ('text' in c ? c.text : undefined))
          .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
          .join('\n'));
        if (answer === '') answer = null;
        break;
      }

      // Dispatch every tool request in this turn, then hand all results back.
      const results: ContentBlock[] = [];
      for (const block of reply.content ?? []) {
        if (!('toolUse' in block) || block.toolUse === undefined) continue;
        const { toolUseId, name, input } = block.toolUse;
        if (toolUseId === undefined || name === undefined) continue;

        const outcome = await dispatch(mcp, name, input, queries, refusals);
        results.push({
          toolResult: {
            toolUseId,
            content: [{ text: outcome.text }],
            status: outcome.ok ? 'success' : 'error',
          },
        });
      }

      if (results.length === 0) { failure = 'model asked for tool use but sent no tool request'; break; }
      messages.push({ role: 'user', content: results });
    }

    if (answer === null && failure === null) {
      failure = `no answer after ${MAX_TURNS} turns`;
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  const latencyMs = Date.now() - started;
  await finishRun(pool, runId, { promptTokens, completionTokens, latencyMs, error: failure })
    .catch(() => { /* the original failure matters more */ });

  return { answer, queries, turns, promptTokens, completionTokens, latencyMs, refusals, error: failure };
}

/**
 * Removes reasoning markup from an answer.
 *
 * Nova emits `<thinking>…</thinking>` around its working despite being asked
 * for plain prose. Harmless to the model, confusing to an ops lead, so it is
 * stripped rather than shown. Handles the unclosed case too — a truncated
 * response can open the tag and never close it, and leaving the tail visible
 * would be worse than dropping it.
 */
/** Truncates a tool result for display without hiding that it was truncated. */
function preview(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= 1200 ? trimmed : `${trimmed.slice(0, 1200)}\n… truncated (${trimmed.length} chars)`;
}

function stripReasoningMarkup(text: string): string {
  return text
    .replace(/<(thinking|reasoning|scratchpad)>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(thinking|reasoning|scratchpad)>[\s\S]*$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The enforcement boundary. Everything the model asks for passes through here.
 */
async function dispatch(
  mcp: McpClient,
  name: string,
  rawInput: unknown,
  queries: AnalystQuery[],
  refusals: string[],
): Promise<{ ok: boolean; text: string }> {
  const started = Date.now();

  if (!ALLOWED_TOOLS.has(name)) {
    const message = `refused: "${name}" is not on the read-only allowlist`;
    refusals.push(message);
    queries.push({ tool: name, sql: null, ok: false, detail: message, ms: 0, result: null });
    return { ok: false, text: message };
  }

  const input = (rawInput ?? {}) as Record<string, unknown>;

  try {
    if (name === 'get_table_schema') {
      const table = String(input.table ?? '');
      if (!(READABLE_TABLES as readonly string[]).includes(table)) {
        const message = `refused: "${table}" is not a readable table`;
        refusals.push(message);
        queries.push({ tool: name, sql: null, ok: false, detail: message, ms: Date.now() - started, result: null });
        return { ok: false, text: message };
      }
      const text = await mcp.callTool('get_table_schema', { database: DATABASE, table });
      queries.push({ tool: name, sql: `schema of ${table}`, ok: true, detail: 'ok', ms: Date.now() - started, result: preview(text) });
      return { ok: true, text };
    }

    // select_query
    const sql = String(input.query ?? input.sql ?? '').trim();
    const rejection = rejectNonSelect(sql);
    if (rejection !== null) {
      refusals.push(rejection);
      queries.push({ tool: name, sql, ok: false, detail: rejection, ms: Date.now() - started, result: null });
      return { ok: false, text: `refused: ${rejection}` };
    }

    const text = await mcp.callTool('select_query', { database: DATABASE, query: sql });
    queries.push({ tool: name, sql, ok: true, detail: 'ok', ms: Date.now() - started, result: preview(text) });
    return { ok: true, text };
  } catch (err) {
    const message = err instanceof McpError ? err.message : String(err);
    queries.push({ tool: name, sql: String(input.query ?? input.sql ?? '') || null, ok: false, detail: message, ms: Date.now() - started, result: null });
    // Returned as a tool error rather than thrown: the model can usually fix
    // its own SQL if it is told what went wrong, and that is a better outcome
    // than failing the question.
    return { ok: false, text: `query failed: ${message}` };
  }
}

/**
 * Belt-and-braces SELECT check.
 *
 * The MCP server already rejects non-SELECT on `select_query`, and the service
 * account's tools are allowlisted above. This is the third layer, and it is
 * cheap: a defence that only exists remotely is a defence you cannot test.
 */
export function rejectNonSelect(sql: string): string | null {
  if (sql === '') return 'empty query';
  if (sql.length > 4000) return 'query too long';

  const normalised = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim();

  if (!/^(select|with)\b/i.test(normalised)) return 'only SELECT (or WITH … SELECT) is permitted';

  // Semicolon anywhere but a trailing one implies statement chaining.
  if (normalised.replace(/;\s*$/, '').includes(';')) return 'multiple statements are not permitted';

  const banned = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|upsert|import|export|backup|restore|set\s+cluster)\b/i;
  const hit = banned.exec(normalised);
  if (hit !== null) return `"${hit[1]}" is not permitted on the read-only path`;

  if (/\b(crdb_internal|pg_catalog|information_schema|pg_extension)\b/i.test(normalised)) {
    return 'system schemas are not readable';
  }
  return null;
}

// ---------------------------------------------------------------------------

async function beginRun(pool: pg.Pool, modelId: string): Promise<string> {
  // case_id is null: an analyst question is about the corpus, not one case.
  // agent_runs.case_id is nullable precisely so cross-case activity is still
  // recorded rather than silently unobserved.
  const { rows } = await pool.query(
    `INSERT INTO agent_runs (case_id, model_id) VALUES (NULL, $1) RETURNING id::STRING AS id`,
    [`analyst:${modelId}`],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('failed to open an agent_runs row for the analyst');
  return String(id);
}

async function finishRun(
  pool: pg.Pool,
  runId: string,
  input: { promptTokens: number | null; completionTokens: number | null; latencyMs: number; error: string | null },
): Promise<void> {
  await pool.query(
    `UPDATE agent_runs
        SET prompt_tokens = $2, completion_tokens = $3, latency_ms = $4, error = $5
      WHERE id = $1`,
    [runId, input.promptTokens, input.completionTokens, input.latencyMs, input.error],
  );
}
