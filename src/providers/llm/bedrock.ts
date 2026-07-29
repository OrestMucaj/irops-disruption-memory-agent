import type {
  LLMCompletionRequest,
  LLMCompletionResult,
  LLMProvider,
} from '../types.js';
import { ProviderNotConfiguredError } from '../types.js';

/**
 * Amazon Bedrock LLM provider — NOT YET IMPLEMENTED.
 *
 * Deliberately a stub, for the same reason as BedrockEmbeddingProvider: SPEC
 * §1.2 forbids coding against an unproven API, and no AWS account exists yet.
 *
 * Unlike the embedding provider, the request shape here is NOT yet researched.
 * NOTES.md covers Bedrock *embedding* models only. Before implementing, settle
 * two things against the live docs and a smoke test:
 *
 *  1. Which API — the Converse API (uniform across models) or InvokeModel
 *     (per-model request bodies). Do not assume; they have different shapes and
 *     different token-usage reporting.
 *  2. Which model ID, confirmed via ListFoundationModels against the real
 *     account rather than copied from a docs page. NOTES.md §4.3 records a case
 *     where AWS's own prose and code sample disagreed on a model ID.
 *
 * Also confirm model access is enabled in the target region before writing any
 * of it (NOTES.md §4.6).
 *
 * Whatever the implementation, it owes the caller real `promptTokens` and
 * `completionTokens` where the API reports them — those feed agent_runs, and
 * an observability table full of estimates is not observability.
 */
export class BedrockLLMProvider implements LLMProvider {
  public readonly name = 'bedrock';
  public readonly modelId: string;
  public readonly region: string;

  constructor(options: { modelId: string; region: string }) {
    this.modelId = options.modelId;
    this.region = options.region;
  }

  public complete(_request: LLMCompletionRequest): Promise<LLMCompletionResult> {
    return Promise.reject(
      new ProviderNotConfiguredError(
        'BedrockLLMProvider',
        'No AWS account is wired up yet. Set LLM_PROVIDER=fake for local ' +
          'development, or implement this once Bedrock model access is ' +
          'confirmed and the Converse-vs-InvokeModel choice is settled.',
      ),
    );
  }
}
