/**
 * Provider contracts.
 *
 * The app must boot and run with no cloud credentials at all (see README,
 * "Running without any live services"). Everything that talks to a model sits
 * behind one of these two interfaces, so the agent loop can be built and tested
 * offline and the real services can be swapped in later without touching it.
 *
 * These interfaces are deliberately narrow. They describe what the agent needs,
 * not what Bedrock offers.
 */

/**
 * Thrown by a provider that exists but has not been wired up to its backing
 * service yet.
 *
 * This is distinct from a runtime failure of a configured provider. If a real
 * provider is configured and then fails, that failure must surface as itself —
 * it must never be swallowed or quietly downgraded to the fake provider. A
 * silent fallback to fake embeddings would poison the memory layer with vectors
 * that are not comparable to the real ones, and nothing downstream would notice.
 */
export class ProviderNotConfiguredError extends Error {
  public readonly providerName: string;

  constructor(providerName: string, nextStep?: string) {
    const suffix = nextStep === undefined ? '' : ` ${nextStep}`;
    super(`${providerName} is not yet configured.${suffix}`);
    this.name = 'ProviderNotConfiguredError';
    this.providerName = providerName;
  }
}

/** Raised when a provider returns something structurally unusable. */
export class ProviderResponseError extends Error {
  public readonly providerName: string;

  constructor(providerName: string, message: string) {
    super(`${providerName}: ${message}`);
    this.name = 'ProviderResponseError';
    this.providerName = providerName;
  }
}

/**
 * Turns text into a vector.
 *
 * `dimensions` is part of the contract rather than an implementation detail:
 * it must match the `VECTOR(n)` width in migrations/001_init.sql, and config
 * validation checks that at boot. Vectors of the wrong width are rejected by
 * the database; vectors of the right width from the *wrong model* are not, and
 * are far more dangerous — they silently degrade retrieval instead of failing.
 * That is why `modelId` is recorded alongside every stored embedding.
 */
export interface EmbeddingProvider {
  /** Short identifier for logs, e.g. "fake" or "bedrock". */
  readonly name: string;

  /** Recorded in case_embeddings.model_id / resolutions.model_id. */
  readonly modelId: string;

  /** Length of the returned vector. */
  readonly dimensions: number;

  /**
   * Embed a single string.
   *
   * Single-item by design. Amazon Titan takes one `inputText` per call, and
   * Bedrock throttles embedding models by requests-per-minute rather than
   * tokens-per-minute (NOTES.md §4.5), so a batch API here would be a
   * sequential loop wearing a disguise. Callers that need many embeddings
   * should loop and rate-limit themselves, visibly.
   */
  embed(text: string): Promise<number[]>;
}

export interface LLMCompletionRequest {
  readonly system: string;
  readonly user: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface LLMCompletionResult {
  /** Raw model output. Parsing and validation are the caller's job. */
  readonly text: string;

  /**
   * Token counts, for the agent_runs observability table (SPEC §4).
   * `null` when the provider does not report them — recording "unknown" is
   * honest, recording a guessed number is not.
   */
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
}

/**
 * Single-shot text completion.
 *
 * No streaming, no tool-calling, no multi-turn. SPEC §5.2 specifies one call
 * per case producing strict JSON, and the interface says exactly that much.
 */
export interface LLMProvider {
  readonly name: string;
  readonly modelId: string;
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResult>;
}
