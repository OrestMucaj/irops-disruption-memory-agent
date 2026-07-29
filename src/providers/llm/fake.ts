import type {
  LLMCompletionRequest,
  LLMCompletionResult,
  LLMProvider,
} from '../types.js';

/** What the fake returns when no canned response is supplied. */
const DEFAULT_RESPONSE = JSON.stringify({ actions: [] });

/**
 * Deterministic, offline LLM provider for local development and tests.
 *
 * Returns a canned string. It does no reasoning whatsoever — its job is to let
 * the plumbing around the model call (retrieval, JSON parsing, validation,
 * persistence, agent_runs logging) be built and tested without an AWS account
 * and without spending money on every iteration.
 *
 * The default response is `{"actions": []}`: valid JSON, structurally plausible,
 * and deliberately empty. The real action schema is defined in M3 (SPEC §5.2),
 * and hardcoding a guess at it here would just create something to unpick later.
 * Tests that need a specific payload should pass one in:
 *
 *   new FakeLLMProvider({ cannedResponse: '{"actions":[{"action_type":"rebook"}]}' })
 *
 * To exercise the error path (SPEC §5.2 requires parse failures to degrade
 * gracefully rather than crash), pass something unparseable:
 *
 *   new FakeLLMProvider({ cannedResponse: 'this is not json' })
 */
export class FakeLLMProvider implements LLMProvider {
  public readonly name = 'fake';
  public readonly modelId = 'fake-llm-v1';

  private readonly cannedResponse: string;

  constructor(options: { cannedResponse?: string } = {}) {
    this.cannedResponse = options.cannedResponse ?? DEFAULT_RESPONSE;
  }

  public complete(request: LLMCompletionRequest): Promise<LLMCompletionResult> {
    return Promise.resolve({
      text: this.cannedResponse,
      // Synthetic counts, derived deterministically from length. They exist so
      // the agent_runs logging path can be exercised offline. They are NOT
      // real tokenizer output and must never be treated as cost data.
      promptTokens: estimateTokens(`${request.system}\n${request.user}`),
      completionTokens: estimateTokens(this.cannedResponse),
    });
  }
}

/** Crude chars-to-tokens approximation. Deterministic, and only ever a stand-in. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
