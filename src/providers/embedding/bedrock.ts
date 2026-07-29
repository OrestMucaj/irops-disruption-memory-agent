import type { EmbeddingProvider } from '../types.js';
import { ProviderNotConfiguredError } from '../types.js';

/**
 * Amazon Bedrock embedding provider — NOT YET IMPLEMENTED.
 *
 * Deliberately a stub. SPEC §1.2 forbids writing code against an API whose
 * behaviour has not been proven with a smoke test first, and no AWS account
 * exists yet. Constructing this is fine; calling `embed()` throws.
 *
 * Implementation is mechanical once an account exists — the exact request and
 * response shapes are already recorded in NOTES.md §4.1, verified against the
 * AWS docs:
 *
 *   Model ID:  amazon.titan-embed-text-v2:0
 *   Request:   { "inputText": string, "dimensions": int, "normalize": boolean }
 *              `dimensions` accepts 1024 (default), 512, 256
 *   Response:  { "embedding": [float...], "inputTextTokenCount": int }
 *
 * Two traps recorded during research, worth re-reading before writing this:
 *
 *  1. Leave `embeddingTypes` unset. If it is set to `["binary"]` only, the
 *     `embedding` field is absent from the response entirely.
 *  2. Bedrock throttles embedding models by requests-per-minute, not
 *     tokens-per-minute (NOTES.md §4.5). The M2 backfill must rate-limit.
 *
 * Before implementing, confirm model access is enabled for this model in the
 * target region — NOTES.md §4.6 flags it as a common day-one blocker.
 */
export class BedrockEmbeddingProvider implements EmbeddingProvider {
  public readonly name = 'bedrock';
  public readonly modelId: string;
  public readonly dimensions: number;
  public readonly region: string;

  constructor(options: { modelId: string; dimensions: number; region: string }) {
    this.modelId = options.modelId;
    this.dimensions = options.dimensions;
    this.region = options.region;
  }

  public embed(_text: string): Promise<number[]> {
    return Promise.reject(
      new ProviderNotConfiguredError(
        'BedrockEmbeddingProvider',
        'No AWS account is wired up yet. Set EMBEDDING_PROVIDER=fake for local ' +
          'development, or implement this against NOTES.md §4.1 once Bedrock ' +
          'model access is confirmed.',
      ),
    );
  }
}
