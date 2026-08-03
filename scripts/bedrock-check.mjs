/**
 * Bedrock credentials + model access smoke test.
 *
 *     node --env-file=.env scripts/bedrock-check.mjs
 *
 * SPEC §1.2 requires a standalone smoke test proving a call works before any
 * integration code is written against it. This is that test for the embedding
 * model. Nothing in src/providers/embedding/bedrock.ts should be implemented
 * until this passes.
 *
 * It answers, definitively and in one run, the questions no console page can:
 *
 *   - Do these credentials work at all?
 *   - Is the IAM policy scoped correctly (InvokeModel on this model)?
 *   - Is model access enabled for this model in this region?
 *   - Is the Service Quota above zero? (NOTES.md §6.6 -- the one thing the
 *     October 2025 auto-enablement change did NOT settle.)
 *   - Does the response match the shape recorded in NOTES.md §4.1?
 *   - Do real embeddings actually rank related text closer than unrelated text?
 *
 * Prints no secrets. Costs a fraction of a cent: three short embedding calls at
 * $0.02 per million tokens.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const region = process.env.AWS_REGION ?? 'us-east-1';
const modelId = process.env.BEDROCK_EMBEDDING_MODEL_ID ?? 'amazon.titan-embed-text-v2:0';
const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? '1024');

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  console.error('AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not set in .env.');
  console.error('See README "Setup from zero" for creating a scoped IAM user.');
  process.exit(1);
}

console.log(`region     : ${region}`);
console.log(`model      : ${modelId}`);
console.log(`dimensions : ${dimensions}`);
console.log(`access key : ${process.env.AWS_ACCESS_KEY_ID.slice(0, 4)}...${process.env.AWS_ACCESS_KEY_ID.slice(-4)}`);

const client = new BedrockRuntimeClient({ region });

async function embed(text) {
  const response = await client.send(new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    // Shape verified against the AWS docs and recorded in NOTES.md §4.1.
    // embeddingTypes is deliberately unset: if it is ["binary"] only, the
    // `embedding` field is absent from the response entirely.
    body: JSON.stringify({ inputText: text, dimensions, normalize: true }),
  }));

  const parsed = JSON.parse(new TextDecoder().decode(response.body));
  return parsed;
}

const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

try {
  console.log('\n=== call 1: does it work at all? ===');
  const probe = await embed('Flight delayed 180 minutes by weather, 42 misconnecting passengers.');

  if (!Array.isArray(probe.embedding)) {
    console.log('  FAIL  response has no `embedding` array. Keys: ' + Object.keys(probe).join(', '));
    process.exit(1);
  }
  console.log(`  PASS  got ${probe.embedding.length} dimensions, ${probe.inputTextTokenCount} input tokens`);

  if (probe.embedding.length !== dimensions) {
    console.log(`  FAIL  expected ${dimensions} dimensions but got ${probe.embedding.length}.`);
    console.log('        EMBEDDING_DIMENSIONS and the VECTOR(n) column must agree.');
    process.exit(1);
  }
  console.log(`  PASS  matches EMBEDDING_DIMENSIONS and the VECTOR(${dimensions}) column`);

  const norm = Math.sqrt(dot(probe.embedding, probe.embedding));
  console.log(`  ..    L2 norm ${norm.toFixed(6)} ${Math.abs(norm - 1) < 0.01 ? '(normalized, as documented)' : '(NOT normalized -- check `normalize`)'}`);

  console.log('\n=== calls 2-3: do embeddings rank sensibly? ===');
  const similar = await embed('Flight held three hours due to storms, dozens of passengers missed connections.');
  const unrelated = await embed('Quarterly catering inventory reconciliation and audit schedule.');

  const simScore = dot(probe.embedding, similar.embedding);
  const unrelScore = dot(probe.embedding, unrelated.embedding);
  console.log(`  cosine(weather, similar weather) = ${simScore.toFixed(4)}`);
  console.log(`  cosine(weather, unrelated)       = ${unrelScore.toFixed(4)}`);

  if (simScore > unrelScore) {
    console.log('  PASS  related text ranks closer than unrelated text');
  } else {
    console.log('  FAIL  ranking is inverted; something is wrong with the model or the request');
    process.exit(1);
  }

  console.log('\nBedrock is usable. Safe to implement BedrockEmbeddingProvider.');
} catch (err) {
  console.log(`\n  FAIL  ${err.name}: ${err.message}`);

  const hints = {
    AccessDeniedException:
      'The IAM policy does not allow bedrock:InvokeModel on this model ARN, or model\n' +
      '        access is not enabled for it in this region. Check the inline policy on the\n' +
      '        IAM user, and the model in the Bedrock console.',
    ValidationException:
      'The request body was rejected. Check the model ID and that `dimensions` is one\n' +
      '        of 1024 / 512 / 256 for Titan V2.',
    ResourceNotFoundException:
      'That model ID does not exist in this region. Check BEDROCK_EMBEDDING_MODEL_ID\n' +
      '        and AWS_REGION.',
    ThrottlingException:
      'Rate limited. If this happens on the very first call, the account Service Quota\n' +
      '        for this model may be zero -- request an increase in Service Quotas.',
    UnrecognizedClientException:
      'The access key is not valid. Re-check AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.',
    InvalidSignatureException:
      'The secret key does not match the access key ID, or has stray whitespace in .env.',
  };

  const hint = hints[err.name];
  if (hint) console.log(`\n  Likely cause:\n        ${hint}`);
  process.exit(1);
}
