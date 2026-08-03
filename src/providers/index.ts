/**
 * Provider selection.
 *
 * The only place in the codebase that knows which implementation is in use.
 * Everything downstream takes an `EmbeddingProvider` / `LLMProvider` and cannot
 * tell the difference — which is the point: the agent loop is developed offline
 * against the fakes and deployed against Bedrock without changing a line.
 */

import type { Config } from '../config.js';
import { ConfigError } from '../config.js';

import { BedrockEmbeddingProvider } from './embedding/bedrock.js';
import { FakeEmbeddingProvider } from './embedding/fake.js';
import { BedrockLLMProvider } from './llm/bedrock.js';
import { FakeLLMProvider } from './llm/fake.js';
import { HeuristicLLMProvider } from './llm/heuristic.js';
import type { EmbeddingProvider, LLMProvider } from './types.js';

export type { EmbeddingProvider, LLMProvider } from './types.js';
export type { LLMCompletionRequest, LLMCompletionResult } from './types.js';
export { ProviderNotConfiguredError, ProviderResponseError } from './types.js';
export { FakeEmbeddingProvider } from './embedding/fake.js';
export { BedrockEmbeddingProvider } from './embedding/bedrock.js';
export { FakeLLMProvider } from './llm/fake.js';
export { HeuristicLLMProvider } from './llm/heuristic.js';
export { BedrockLLMProvider } from './llm/bedrock.js';

export function createEmbeddingProvider(config: Config): EmbeddingProvider {
  switch (config.embeddingProvider) {
    case 'fake':
      return new FakeEmbeddingProvider(config.embeddingDimensions);

    case 'bedrock':
      return new BedrockEmbeddingProvider({
        modelId: required(config.bedrockEmbeddingModelId, 'BEDROCK_EMBEDDING_MODEL_ID'),
        dimensions: config.embeddingDimensions,
        region: config.awsRegion,
      });

    default:
      return assertNever(config.embeddingProvider, 'EMBEDDING_PROVIDER');
  }
}

export function createLLMProvider(config: Config): LLMProvider {
  switch (config.llmProvider) {
    case 'fake':
      return new FakeLLMProvider();

    case 'heuristic':
      return new HeuristicLLMProvider();

    case 'bedrock':
      return new BedrockLLMProvider({
        modelId: required(config.bedrockLlmModelId, 'BEDROCK_LLM_MODEL_ID'),
        region: config.awsRegion,
      });

    default:
      return assertNever(config.llmProvider, 'LLM_PROVIDER');
  }
}

/**
 * `loadConfig` already rejects a bedrock provider with no model ID, so this
 * should be unreachable. It exists to narrow `string | null` to `string`
 * without an assertion — if the invariant ever breaks, this says which env var
 * is missing instead of failing later with "undefined is not a model".
 */
function required(value: string | null, envVar: string): string {
  if (value === null) {
    throw new ConfigError([`${envVar} is required but was not set.`]);
  }
  return value;
}

/** Makes adding a third provider kind a compile error rather than a silent gap. */
function assertNever(value: never, envVar: string): never {
  throw new ConfigError([`${envVar}: unsupported provider "${String(value)}".`]);
}
