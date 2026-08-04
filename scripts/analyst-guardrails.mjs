/**
 * Analyst guardrail tests — the read-only boundary, exercised directly.
 *
 *     node --env-file=.env scripts/analyst-guardrails.mjs
 *
 * The analyst is the one place in this system where a MODEL writes SQL. Read-
 * only cannot be enforced by the credential (NOTES.md §2.5: the platform
 * requires Cluster Operator or Admin and offers no read-only role), so it is
 * enforced by src/mcp/analyst.ts. That makes these tests the actual security
 * control, not a nicety.
 *
 * Rather than trying to coax a model into misbehaving — unreliable, and it
 * would pass for the wrong reason on a well-behaved day — this calls the
 * enforcement function directly with exactly the inputs a compromised or
 * confused model would produce.
 */

import { rejectNonSelect as reject } from '../dist/mcp/analyst.js';

const cases = [
  // [label, sql, expectRejected]
  ['plain SELECT', 'SELECT count(*) FROM disruption_cases LIMIT 10', false],
  ['WITH … SELECT', 'WITH x AS (SELECT 1 AS n) SELECT n FROM x LIMIT 1', false],
  ['trailing semicolon is tolerated', 'SELECT 1 LIMIT 1;', false],

  ['INSERT', "INSERT INTO resolutions (case_id) VALUES ('x')", true],
  ['UPDATE', "UPDATE disruption_cases SET status = 'resolved'", true],
  ['DELETE', 'DELETE FROM agent_runs', true],
  ['DROP', 'DROP TABLE resolutions', true],
  ['TRUNCATE', 'TRUNCATE passengers', true],
  ['ALTER', 'ALTER TABLE passengers ADD COLUMN x INT', true],
  ['GRANT', 'GRANT ALL ON DATABASE defaultdb TO public', true],
  ['SET CLUSTER SETTING', 'SET CLUSTER SETTING feature.vector_index.enabled = false', true],

  ['statement chaining', 'SELECT 1; DROP TABLE resolutions', true],
  ['chaining behind a comment', 'SELECT 1 -- ok\n; DELETE FROM passengers', true],
  ['write hidden in a block comment', '/* SELECT */ UPDATE passengers SET pax_ref = 1', true],
  ['CTE that writes', 'WITH d AS (DELETE FROM agent_runs RETURNING 1) SELECT * FROM d', true],

  ['crdb_internal', 'SELECT * FROM crdb_internal.tables LIMIT 1', true],
  ['pg_catalog', 'SELECT * FROM pg_catalog.pg_tables LIMIT 1', true],
  ['information_schema', 'SELECT * FROM information_schema.columns LIMIT 1', true],

  ['empty', '', true],
  ['oversized', `SELECT ${'a'.repeat(4100)}`, true],
];

let failures = 0;
for (const [label, sql, expectRejected] of cases) {
  const verdict = reject(sql);
  const rejected = verdict !== null;
  if (rejected === expectRejected) {
    console.log(`  PASS  ${expectRejected ? 'refused ' : 'allowed '} ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}`);
    console.log(`        expected ${expectRejected ? 'refusal' : 'acceptance'}, got ${rejected ? `refusal: ${verdict}` : 'acceptance'}`);
  }
}

console.log(failures === 0
  ? `\nAll ${cases.length} guardrail cases held.`
  : `\n${failures} of ${cases.length} FAILED.`);
process.exit(failures === 0 ? 0 : 1);
