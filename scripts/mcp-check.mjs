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

  const dbTool = info.tools.find((t) => t.name === 'list_databases');
  if (dbTool) {
    show('list_databases', await client.callTool('list_databases', argsFor(dbTool, {})));
  }

  const schemaTool = info.tools.find((t) => t.name === 'get_table_schema');
  if (schemaTool) {
    show('get_table_schema · case_embeddings',
      await client.callTool('get_table_schema',
        argsFor(schemaTool, { database: 'defaultdb', table: 'case_embeddings' })));
  }

  const selectTool = info.tools.find((t) => t.name === 'select_query');
  if (!selectTool) throw new Error('select_query is not offered — the analyst path cannot work');

  const sql =
    "SELECT case_status, count(*)::INT AS cases FROM case_embeddings GROUP BY case_status ORDER BY cases DESC LIMIT 10";
  show(`select_query · ${sql}`,
    await client.callTool('select_query', argsFor(selectTool, { sql, database: 'defaultdb' })));

  console.log('\nPASS — the Managed MCP Server reads the memory layer with a service-account key.');
  console.log('SPEC §7 option (a) is confirmed feasible.');
} catch (err) {
  console.error(`\nFAIL  ${err.message}`);
  process.exit(1);
}
