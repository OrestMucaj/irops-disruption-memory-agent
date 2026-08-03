/**
 * Configuration, loaded and validated once at boot.
 *
 * Two rules this module exists to enforce:
 *
 *  1. The app boots with no cloud credentials. Defaults select the fake
 *     providers, so a fresh clone runs offline (README, "Running without any
 *     live services").
 *  2. Bad configuration fails loudly at startup, not on the first request.
 *     All problems are reported together — fixing env vars one error message at
 *     a time is miserable.
 */

/**
 * The `VECTOR(n)` width declared in migrations/001_init.sql.
 *
 * Chosen to match Amazon Titan Text Embeddings V2 at its default dimension
 * (NOTES.md §4.1, §5.1). This constant and the DDL must agree — see the
 * dimension check in `loadConfig`.
 */
export const SCHEMA_EMBEDDING_DIMENSIONS = 1024;

export const EMBEDDING_PROVIDER_KINDS = ['fake', 'bedrock'] as const;
export type EmbeddingProviderKind = (typeof EMBEDDING_PROVIDER_KINDS)[number];

/**
 * `heuristic` is an LLM-side option only — there is no heuristic *embedding*
 * provider, which is why these two lists are separate rather than one shared
 * union. See src/providers/llm/heuristic.ts: it is a decision tree for
 * developing the loop without AWS, never the demo path.
 */
export const LLM_PROVIDER_KINDS = ['fake', 'heuristic', 'bedrock'] as const;
export type LLMProviderKind = (typeof LLM_PROVIDER_KINDS)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export class ConfigError extends Error {
  public readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    const list = problems.map((p) => `  - ${p}`).join('\n');
    super(`Invalid configuration:\n${list}\n\nSee .env.example for the annotated list.`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export interface Config {
  /**
   * CockroachDB connection string. `null` is permitted: the provider layer and
   * its tests do not need a database, and no cluster exists yet. Code that
   * actually needs a connection must check and fail with its own clear message.
   */
  readonly databaseUrl: string | null;

  readonly embeddingProvider: EmbeddingProviderKind;
  readonly llmProvider: LLMProviderKind;

  /** Always equal to SCHEMA_EMBEDDING_DIMENSIONS; validated at load. */
  readonly embeddingDimensions: number;

  readonly awsRegion: string;
  readonly bedrockEmbeddingModelId: string | null;
  readonly bedrockLlmModelId: string | null;

  /**
   * CockroachDB Cloud Managed MCP Server (the analyst path, SPEC §7).
   * All three nullable: the analyst feature switches off cleanly when they are
   * absent rather than half-configuring itself.
   */
  readonly mcpUrl: string;
  readonly mcpApiKey: string | null;
  readonly mcpClusterId: string | null;

  /** Guardrails — SPEC §5.4. */
  readonly maxModelCallsPerCase: number;
  readonly dbTimeoutMs: number;
  readonly modelTimeoutMs: number;
  readonly retrievalTopK: number;

  readonly logLevel: LogLevel;
}

export type Env = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];

  const embeddingProvider = readEnum(env, 'EMBEDDING_PROVIDER', EMBEDDING_PROVIDER_KINDS, 'fake', problems);
  const llmProvider = readEnum(env, 'LLM_PROVIDER', LLM_PROVIDER_KINDS, 'fake', problems);

  const embeddingDimensions = readInt(
    env,
    'EMBEDDING_DIMENSIONS',
    SCHEMA_EMBEDDING_DIMENSIONS,
    { min: 1, max: 16_000 },
    problems,
  );

  // The schema declares a fixed vector width, so this is not a preference —
  // a mismatch means every insert would be rejected by the database, and it is
  // far kinder to say so at boot than to discover it mid-backfill.
  if (embeddingDimensions !== SCHEMA_EMBEDDING_DIMENSIONS) {
    problems.push(
      `EMBEDDING_DIMENSIONS is ${embeddingDimensions}, but the schema declares ` +
        `VECTOR(${SCHEMA_EMBEDDING_DIMENSIONS}) in migrations/001_init.sql. ` +
        `Changing embedding width is a migration, not a config edit: the column ` +
        `must be altered and every stored vector re-embedded, because vectors of ` +
        `different widths (or from different models) are not comparable.`,
    );
  }

  const awsRegion = readString(env, 'AWS_REGION') ?? 'us-east-1';
  const bedrockEmbeddingModelId = readString(env, 'BEDROCK_EMBEDDING_MODEL_ID');
  const bedrockLlmModelId = readString(env, 'BEDROCK_LLM_MODEL_ID');

  if (embeddingProvider === 'bedrock' && bedrockEmbeddingModelId === null) {
    problems.push(
      'EMBEDDING_PROVIDER=bedrock requires BEDROCK_EMBEDDING_MODEL_ID to be set ' +
        '(NOTES.md §4.1 suggests amazon.titan-embed-text-v2:0).',
    );
  }

  if (llmProvider === 'bedrock' && bedrockLlmModelId === null) {
    problems.push('LLM_PROVIDER=bedrock requires BEDROCK_LLM_MODEL_ID to be set.');
  }

  const config: Config = {
    databaseUrl: readString(env, 'DATABASE_URL'),
    embeddingProvider,
    llmProvider,
    embeddingDimensions,
    awsRegion,
    bedrockEmbeddingModelId,
    bedrockLlmModelId,
    mcpUrl: readString(env, 'MCP_URL') ?? 'https://cockroachlabs.cloud/mcp',
    mcpApiKey: readString(env, 'MCP_API_KEY'),
    mcpClusterId: readString(env, 'MCP_CLUSTER_ID'),
    maxModelCallsPerCase: readInt(env, 'MAX_MODEL_CALLS_PER_CASE', 3, { min: 1, max: 100 }, problems),
    dbTimeoutMs: readInt(env, 'DB_TIMEOUT_MS', 5_000, { min: 100, max: 120_000 }, problems),
    modelTimeoutMs: readInt(env, 'MODEL_TIMEOUT_MS', 30_000, { min: 100, max: 300_000 }, problems),
    retrievalTopK: readInt(env, 'RETRIEVAL_TOP_K', 5, { min: 1, max: 50 }, problems),
    logLevel: readEnum(env, 'LOG_LEVEL', LOG_LEVELS, 'info', problems),
  };

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  return config;
}

/**
 * Redacted view of the config, safe to log at startup.
 *
 * DATABASE_URL carries a password, so it is never logged (SPEC §1.3). Reporting
 * only whether it is set is enough to debug "why can't it connect".
 */
export function describeConfig(config: Config): Record<string, string | number | boolean> {
  return {
    databaseUrl: config.databaseUrl === null ? '(not set)' : '(set, redacted)',
    embeddingProvider: config.embeddingProvider,
    llmProvider: config.llmProvider,
    embeddingDimensions: config.embeddingDimensions,
    awsRegion: config.awsRegion,
    bedrockEmbeddingModelId: config.bedrockEmbeddingModelId ?? '(not set)',
    bedrockLlmModelId: config.bedrockLlmModelId ?? '(not set)',
    mcpUrl: config.mcpUrl,
    mcpApiKey: config.mcpApiKey === null ? '(not set)' : '(set, redacted)',
    mcpClusterId: config.mcpClusterId ?? '(not set)',
    maxModelCallsPerCase: config.maxModelCallsPerCase,
    dbTimeoutMs: config.dbTimeoutMs,
    modelTimeoutMs: config.modelTimeoutMs,
    retrievalTopK: config.retrievalTopK,
    logLevel: config.logLevel,
  };
}

// ---------------------------------------------------------------------------
// Readers. Each records its problem and returns the fallback, so that one bad
// value does not hide the next one.
// ---------------------------------------------------------------------------

function readString(env: Env, key: string): string | null {
  const raw = env[key];
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function readEnum<T extends string>(
  env: Env,
  key: string,
  allowed: readonly T[],
  fallback: T,
  problems: string[],
): T {
  const raw = readString(env, key);
  if (raw === null) {
    return fallback;
  }

  const value = raw.toLowerCase();
  const match = allowed.find((candidate) => candidate === value);
  if (match !== undefined) {
    return match;
  }

  problems.push(`${key}: expected one of ${allowed.join(' | ')}, got "${raw}"`);
  return fallback;
}

function readInt(
  env: Env,
  key: string,
  fallback: number,
  range: { min: number; max: number },
  problems: string[],
): number {
  const raw = readString(env, key);
  if (raw === null) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    problems.push(
      `${key}: expected an integer between ${range.min} and ${range.max}, got "${raw}"`,
    );
    return fallback;
  }

  return value;
}
