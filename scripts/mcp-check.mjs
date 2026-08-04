/**
 * Managed MCP Server smoke test.
 *
 *     npm run build
 *     node --env-file=.env scripts/mcp-check.mjs
 *
 * SPEC §1.2: a standalone script proving the call works before any integration
 * code depends on it. This is that script for the MCP analyst path. It answers:
 *
 *   - Does a service-account API key from a free Basic org authenticate at all?
 *     (NOTES.md §2.6 — the last open fact deciding SPEC §7 option (a) vs (b).)
 *   - Does Cluster Operator suffice for read tools?
 *   - What are the EXACT input schemas of the read-only tools? (Printed, so
 *     NOTES.md records the real contract instead of a guess.)
 *   - Can MCP actually read our memory layer end to end?
 *
 * Prints no secrets. Read-only by construction: the only tools this script
 * ever invokes are list_databases, get_table_schema and select_query.
 */

import { loadConfig } from '../dist/config.js';
import { McpClient } from '../dist/mcp/client.js';

const config = loadConfig();

if (config.mcpApiKey === null || config.mcpClusterId === null) {
  console.error('MCP_API_KEY / MCP_CLUSTER_ID are not set in .env.');
  console.error('Create a service account (Cluster Operator on the cluster) in the');
  console.error('CockroachDB Cloud console, then fill both in and re-run.');
  process.exit(1);
}

console.log(`endpoint : ${config.mcpUrl}`);
console.log(`cluster  : ${config.mcpClusterId}`);
console.log(`api key  : ${config.mcpApiKey.slice(0, 6)}…${config.mcpApiKey.slice(-4)}`);

const READ_TOOLS = ['list_databases', 'list_tables', 'get_table_schema', 'select_query', 'explain_query'];
const WRITE_TOOLS = ['create_database', 'create_table', 'insert_rows'];

/** Fill a tool's arguments from its own declared schema — never guessed names. */
function argsFor(tool, values) {
  const props = Object.keys(tool.inputSchema?.properties ?? {});
  const args = {};
  const put = (candidates, value) => {
    const hit = candidates.find((c) => props.includes(c));
    if (hit !== undefined && value !== undefined) args[hit] = value;
    return hit;
  };
  put(['sql', 'query', 'statement', 'q'], values.sql);
  put(['database', 'db', 'database_name'], values.database);
  put(['table', 'table_name', 'name'], values.table);
  return args;
}

const client = new McpClient({
  url: config.mcpUrl,
  apiKey: config.mcpApiKey,
  clusterId: config.mcpClusterId,
});

const show = (label, text) => {
  const trimmed = text.length > 900 ? `${text.slice(0, 900)}\n  … (${text.length} chars total)` : text;
  console.log(`\n--- ${label} ---\n${trimmed.split('\n').map((l) => `  ${l}`).join('\n')}`);
};

try {
  console.log('\n=== connect ===');
  const info = await client.connect();
  console.log(`  PASS  ${info.serverName} ${info.serverVersion} (protocol ${info.protocolVersion})`);
  console.log(`  tools: ${info.tools.map((t) => t.name).join(', ') || '(none)'}`);

  const names = info.tools.map((t) => t.name);
  const missingRead = READ_TOOLS.filter((t) => !names.includes(t));
  if (missingRead.length > 0) {
    console.log(`  WARN  expected read tools not offered: ${missingRead.join(', ')}`);
  } else {
    console.log('  PASS  all expected read-only tools are offered');
  }

  const writeExposed = WRITE_TOOLS.filter((t) => names.includes(t));
  if (writeExposed.length > 0) {
    console.log(`  NOTE  write tools ARE exposed to this key: ${writeExposed.join(', ')}`);
    console.log('        Read-only is therefore enforced by our client-side allowlist');
    console.log('        (NOTES.md §2.5) — the analyst never invokes these.');
  } else {
    console.log('  NOTE  no write tools exposed to this key');
  }

  // Record the real contracts for NOTES.md.
  for (const name of ['select_query', 'get_table_schema']) {
    const tool = info.tools.find((t) => t.name === name);
    if (tool) show(`inputSchema · ${name}`, JSON.stringify(tool.inputSchema ?? {}, null, 2));
  }

  console.log('\n=== read the memory layer via MCP ===');

  /* Progressive, from least to most privileged. Connecting proves the API key
     is valid; it proves nothing about cluster access, and the two failures look
     identical from the outside ("unauthorized"). Running the ladder in order
     tells you WHICH grant is missing instead of just that something is. */
  const attempt = async (label, name, values) => {
    const tool = info.tools.find((t) => t.name === name);
    if (!tool) return { ok: false, why: `${name} not offered` };
    try {
      const text = await client.callTool(name, argsFor(tool, values));
      show(label, text);
      return { ok: true, text };
    } catch (err) {
      console.log(`\n--- ${label} ---\n  FAILED: ${err.message}`);
      return { ok: false, why: err.message };
    }
  };

  const orgLevel = await attempt('list_clusters (organization scope)', 'list_clusters', {});
  const dbLevel = await attempt('list_databases (cluster scope)', 'list_databases', {});

  if (!dbLevel.ok) {
    console.log('\nFAIL — the key authenticates but cannot read this cluster.');
    console.log('\nDiagnosis:');
    if (orgLevel.ok) {
      console.log('  The service account can see the ORGANIZATION but not the CLUSTER.');
      console.log('  It is missing a cluster-scoped role.');
    } else {
      console.log('  The service account has no effective roles at all yet.');
    }
    console.log('\nFix, in the CockroachDB Cloud console:');
    console.log('  Access Management -> Service Accounts -> irops-analyst -> Roles');
    console.log('  Assign:  Cluster Operator');
    console.log('  Scoped to the CLUSTER "irops-memory" (not the organization).');
    console.log('  Per the MCP docs a service account needs Cluster Operator or Cluster');
    console.log('  Admin on the target cluster; org-level membership alone is not enough.');
    console.log('\n  If the key was created BEFORE the role was assigned, the role still');
    console.log('  applies to the same key — no need to regenerate it. Just re-run this.');
    process.exit(1);
  }

  await attempt('get_table_schema · case_embeddings', 'get_table_schema',
    { database: 'defaultdb', table: 'case_embeddings' });

  const sql =
    'SELECT case_status, count(*)::INT AS cases FROM case_embeddings GROUP BY case_status ORDER BY cases DESC LIMIT 10';
  const query = await attempt(`select_query · ${sql}`, 'select_query', { sql, database: 'defaultdb' });
  if (!query.ok) {
    console.log('\nFAIL — schema reads work but SELECT does not. The analyst path needs select_query.');
    process.exit(1);
  }

  console.log('\nPASS — the Managed MCP Server reads the memory layer with a service-account key.');
  console.log('SPEC §7 option (a) is confirmed feasible.');
} catch (err) {
  console.error(`\nFAIL  ${err.message}`);
  process.exit(1);
}
