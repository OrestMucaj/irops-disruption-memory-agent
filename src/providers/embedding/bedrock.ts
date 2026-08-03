import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

import type { EmbeddingProvider } from '../types.js';
import { ProviderResponseError } from '../types.js';

/**
 * Amazon Bedrock embedding provider (Amazon Titan Text Embeddings V2).
 *
 * Request and response shapes are those recorded in NOTES.md §4.1 and since
 * confirmed against the live service by `npm run check:bedrock` on 2026-07-29:
 * 1024 dimensions returned, L2 norm 1.000000, related text at cosine 0.575
 * versus 0.044 for unrelated text.
 *
 * Two things the smoke test settled that are worth not re-litigating:
 *
 *  - Titan normalizes by default (`normalize` defaults to true), so cosine
 *    distance and L2 rank identically. The schema uses `vector_cosine_ops`
 *    regardless — see NOTES.md §5.2 for why that is still the right choice.
 *  - `embeddingTypes` is deliberately never set. Setting it to `["binary"]`
 *    alone removes the `embedding` field from the response entirely.
 *
 * There is no fallback to the fake provider on failure, by design. A silent
 * downgrade would write vectors that are not comparable with the stored ones
 * and nothing downstream would notice (see providers/types.ts).
 */
export class BedrockEmbeddingProvider implements EmbeddingProvider {
  public readonly name = 'bedrock';
  public readonly modelId: string;
  public readonly dimensions: number;
  public readonly region: string;

  private readonly client: BedrockRuntimeClient;

  constructor(options: {
    modelId: string;
    dimensions: number;
    region: string;
    /** Overridable so tests can inject a stub client. */
    client?: BedrockRuntimeClient;
  }) {
    this.modelId = options.modelId;
    this.dimensions = options.dimensions;
    this.region = options.region;
    this.client = options.client
      ?? new BedrockRuntimeClient({
        region: options.region,
        // The SDK retries throttling and transient 5xx by default. Three
        // attempts is enough to ride out a brief rate limit without turning a
        // hard failure into a long stall — the caller has its own timeout.
        maxAttempts: 3,
      });
  }

  public async embed(text: string): Promise<number[]> {
    if (text.trim() === '') {
      // Titan rejects empty input, and an all-zero vector would be worse: it
      // has undefined cosine distance to everything and would quietly poison
      // retrieval rather than failing.
      throw new ProviderResponseError(
        'BedrockEmbeddingProvider',
        'refusing to embed empty text',
      );
    }

    const response = await this.client.send(
      new InvokeModelCommand({
        modelId: this.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          inputText: text,
          dimensions: this.dimensions,
          normalize: true,
        }),
      }),
    );

    if (response.body === undefined) {
      throw new ProviderResponseError('BedrockEmbeddingProvider', 'response had no body');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(response.body));
    } catch (err) {
      throw new ProviderResponseError(
        'BedrockEmbeddingProvider',
        `response body was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const embedding = (parsed as { embedding?: unknown }).embedding;
    if (!Array.isArray(embedding)) {
      throw new ProviderResponseError(
        'BedrockEmbeddingProvider',
        `response had no 'embedding' array (keys: ${Object.keys(parsed as object).join(', ')})`,
      );
    }

    // Width is checked rather than trusted. A vector of the wrong length is
    // rejected by the VECTOR(n) column anyway, but failing here names the
    // actual cause instead of surfacing as a confusing database error several
    // frames away.
    if (embedding.length !== this.dimensions) {
      throw new ProviderResponseError(
        'BedrockEmbeddingProvider',
        `expected ${this.dimensions} dimensions, got ${embedding.length}`,
      );
    }

    return embedding as number[];
  }
}
