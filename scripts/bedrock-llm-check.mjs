/**
 * Reasoning-model discovery and smoke test.
 *
 *     node --env-file=.env scripts/bedrock-llm-check.mjs
 *
 * SPEC §1.2 forbids guessing API details, and NOTES.md §4.3 records AWS's own
 * documentation contradicting itself on a model ID. So rather than picking one
 * and hoping, this probes a candidate list with a real (tiny) Converse call and
 * reports which IDs this account can actually invoke in this region.
 *
 * Probing is not guessing: every reported result is a verified round trip.
 *
 * The Converse request/response shape below is quoted from the AWS API
 * reference for Converse:
 *   request : { messages: [{role, content:[{text}]}], system: [{text}],
 *               inferenceConfig: { maxTokens, temperature, topP, stopSequences } }
 *   response: { output: { message: { content: [{text}], role } },
 *               stopReason, usage: { inputTokens, outputTokens, totalTokens },
 *               metrics: { latencyMs } }
 *
 * Each probe costs a handful of tokens. The whole run is well under a cent.
 */

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const region = process.env.AWS_REGION ?? 'us-east-1';

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  console.error('AWS credentials are not set in .env.');
  process.exit(1);
}

// Amazon's own models need no use-case form; Anthropic's require a one-time
// submission per account, so they may legitimately fail here even when the
// account is otherwise healthy. Both bare IDs and us.* inference profiles are
// probed because on-demand availability differs between them.
const CANDIDATES = process.argv[2] !== undefined ? [process.argv[2]] : [
  'amazon.nova-micro-v1:0',
  'amazon.nova-lite-v1:0',
  'amazon.nova-pro-v1:0',
  'us.amazon.nova-micro-v1:0',
  'us.amazon.nova-lite-v1:0',
  'anthropic.claude-3-5-haiku-20241022-v1:0',
  'us.anthropic.claude-3-5-haiku-20241022-v1:0',
];

const client = new BedrockRuntimeClient({ region, maxAttempts: 2 });

// Deliberately asks for strict JSON: this is a rehearsal of what the agent
// actually does, not a "say hello" test. A model that cannot follow this
// instruction is not a candidate regardless of whether it responds.
const SYSTEM = 'You reply with strict JSON only. No prose, no markdown, no code fences.';
const USER = 'Return exactly {"ok":true,"n":7} and nothing else.';

console.log(`region: ${region}`);
console.log(`probing ${CANDIDATES.length} candidate model id(s)\n`);

const working = [];

for (const modelId of CANDIDATES) {
  process.stdout.write(`  ${modelId.padEnd(46)} `);
  try {
    const started = Date.now();
    const response = await client.send(new ConverseCommand({
      modelId,
      system: [{ text: SYSTEM }],
      messages: [{ role: 'user', content: [{ text: USER }] }],
      inferenceConfig: { maxTokens: 64, temperature: 0 },
    }));

    const text = response.output?.message?.content?.[0]?.text ?? '';
    const usage = response.usage ?? {};
    const elapsed = Date.now() - started;

    let jsonOk = false;
    try {
      const parsed = JSON.parse(text.trim());
      jsonOk = parsed?.ok === true && parsed?.n === 7;
    } catch {
      jsonOk = false;
    }

    console.log(
      `OK  ${String(elapsed).padStart(5)}ms  ` +
      `in=${usage.inputTokens ?? '?'} out=${usage.outputTokens ?? '?'}  ` +
      `stop=${response.stopReason ?? '?'}  ` +
      `strict-json=${jsonOk ? 'yes' : 'NO'}`,
    );
    if (!jsonOk) console.log(`  ${' '.repeat(46)} returned: ${JSON.stringify(text.slice(0, 120))}`);

    working.push({ modelId, elapsed, jsonOk, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
  } catch (err) {
    console.log(`--  ${err.name}`);
  }
}

console.log('');

if (working.length === 0) {
  console.log('No candidate model responded.');
  console.log('\nEither none of these IDs exist in this region, or the IAM policy is too narrow.');
  console.log('To get an authoritative list instead of probing, add this to the policy and');
  console.log('use ListFoundationModels:');
  console.log('    "Action": ["bedrock:ListFoundationModels"], "Resource": "*"');
  process.exit(1);
}

const strict = working.filter((w) => w.jsonOk);
const pool = strict.length > 0 ? strict : working;
const recommended = pool.reduce((a, b) => (a.elapsed <= b.elapsed ? a : b));

console.log(`${working.length} model(s) usable, ${strict.length} of which honoured strict JSON.`);
console.log(`\nRecommended (fastest that returned valid JSON):\n    BEDROCK_LLM_MODEL_ID=${recommended.modelId}`);

if (strict.length === 0) {
  console.log('\nWARNING: none returned parseable JSON on the first try. The agent retries once');
  console.log('and tolerates markdown fences, so this is survivable, but prefer a model that');
  console.log('follows the instruction.');
}
