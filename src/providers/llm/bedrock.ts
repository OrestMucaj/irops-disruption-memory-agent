import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

import type {
  LLMCompletionRequest,
  LLMCompletionResult,
  LLMProvider,
} from '../types.js';
import { ProviderResponseError } from '../types.js';

/**
 * Amazon Bedrock reasoning provider, via the Converse API.
 *
 * **Converse, not InvokeModel.** NOTES.md flagged this choice as unresearched
 * and SPEC §1.2 forbids guessing it. Resolved 2026-07-29 against the AWS API
 * reference and then verified live by `scripts/bedrock-llm-check.mjs`:
 * Converse gives one request shape across every model, so switching between
 * Nova sizes (or to Claude later) is a config change rather than a rewrite,
 * and it reports token usage uniformly — which `agent_runs` needs.
 *
 * Shapes below are quoted from that reference:
 *   request  { messages: [{ role, content: [{ text }] }], system: [{ text }],
 *              inferenceConfig: { maxTokens, temperature, topP, stopSequences } }
 *   response { output: { message: { content: [{ text }], role } },
 *              stopReason, usage: { inputTokens, outputTokens, totalTokens } }
 *
 * Probed and working in us-east-1 on this account: `amazon.nova-micro-v1:0`,
 * `amazon.nova-lite-v1:0`, `amazon.nova-pro-v1:0` — all three returned strict
 * JSON on the first attempt. Anthropic models returned ResourceNotFound
 * (they need the one-time use-case form first).
 */

/**
 * Enough for a full action list with rationales and citations.
 *
 * Raised from 2000 on 2026-08-03 after an evaluation run truncated 5 of 30
 * cases. Only the with-precedent arm failed, and the reason is structural: each
 * action carries `precedent_case_ids` of full 36-character UUIDs plus a
 * rationale referring to them, so a case with several misconnecting passengers
 * and five precedents to cite produces several times the output of the same
 * case with no memory. Truncation therefore looked exactly like "memory makes
 * the agent worse" in the aggregate scores.
 *
 * Output tokens cost $0.24 per million, so the headroom is worth roughly
 * $0.001 per call. Cheap insurance against a failure mode that reads as a
 * quality regression.
 */
const DEFAULT_MAX_TOKENS = 4000;

export class BedrockLLMProvider implements LLMProvider {
  public readonly name = 'bedrock';
  public readonly modelId: string;
  public readonly region: string;

  private readonly client: BedrockRuntimeClient;

  constructor(options: {
    modelId: string;
    region: string;
    /** Overridable so tests can inject a stub client. */
    client?: BedrockRuntimeClient;
  }) {
    this.modelId = options.modelId;
    this.region = options.region;
    this.client = options.client
      ?? new BedrockRuntimeClient({ region: options.region, maxAttempts: 3 });
  }

  public async complete(request: LLMCompletionRequest): Promise<LLMCompletionResult> {
    const response = await this.client.send(
      new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: request.system }],
        messages: [{ role: 'user', content: [{ text: request.user }] }],
        inferenceConfig: {
          maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
          // Defaults to 0: this task wants the same plan for the same facts and
          // precedents. Creativity here is a defect, not a feature.
          temperature: request.temperature ?? 0,
        },
      }),
    );

    const stopReason = response.stopReason;

    // Truncation deserves its own error. The output is guaranteed to be invalid
    // JSON, and the agent's retry would truncate identically — so say what
    // actually happened rather than letting it surface as "not valid JSON"
    // twice and land in agent_runs as a misleading parse failure.
    if (stopReason === 'max_tokens') {
      throw new ProviderResponseError(
        'BedrockLLMProvider',
        `response hit the ${request.maxTokens ?? DEFAULT_MAX_TOKENS}-token limit and was truncated; ` +
          'raise maxTokens or ask for fewer actions',
      );
    }

    if (stopReason === 'content_filtered' || stopReason === 'guardrail_intervened') {
      throw new ProviderResponseError(
        'BedrockLLMProvider',
        `request was blocked by a content filter (stopReason: ${stopReason})`,
      );
    }

    const text = response.output?.message?.content?.[0]?.text;
    if (text === undefined || text.trim() === '') {
      throw new ProviderResponseError(
        'BedrockLLMProvider',
        `response contained no text (stopReason: ${stopReason ?? 'unknown'})`,
      );
    }

    return {
      text,
      // Real counts from the API, not estimates. This is what makes agent_runs
      // usable as cost data rather than decoration.
      promptTokens: response.usage?.inputTokens ?? null,
      completionTokens: response.usage?.outputTokens ?? null,
    };
  }
}
