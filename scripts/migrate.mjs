/**
 * Minimal forward-only migration runner.
 *
 * Applies every migrations/*.sql in filename order, once, recording what ran in
 * a schema_migrations table. Re-running is a no-op.
 *
 *     node --env-file=.env scripts/migrate.mjs
 *     node --env-file=.env scripts/migrate.mjs --dry-run
 *
 * Deliberately small. This is not a migration framework and should not grow
 * into one -- no down-migrations, no branching, no templating. If this project
 * ever needs those, take a real tool rather than extending this file.
 *
 * A checksum of each applied file is stored. If a file changes after being
 * applied, the runner stops rather than silently ignoring the edit -- the usual
 * way schemas drift from the migrations that supposedly describe them.
 *
 * NOTE ON ATOMICITY: each file's statements are sent as one simple query, so
 * CockroachDB applies them together, but the schema_migrations bookkeeping is a
 * separate statement. CockroachDB restricts mixing DDL and DML in one
 * transaction, so this is the boring, working option. The window is tiny and
 * the failure mode is benign: a migration applied but unrecorded, which a
 * re-run surfaces immediately because every statement in 001 is IF NOT EXISTS.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const { Client } = pg;

const dryRun = process.argv.includes('--dry-run');
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const url = process.env.DATABASE_URL;
if (!url || url.includes('PASTE_PASSWORD_HERE')) {
  console.error('DATABASE_URL is not set (or still has the placeholder password).');
  console.error('Run with: node --env-file=.env scripts/migrate.mjs');
  process.exit(1);
}

const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
if (files.length === 0) {
  console.error(`No .sql files in ${migrationsDir}`);
  process.exit(1);
}

const client = new Client({
  connectionString: url,
  ssl: { rejectUnauthorized: true },
  statement_timeout: 300_000,
  connectionTimeoutMillis: 20_000,
});

await client.connect();

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    STRING      NOT NULL PRIMARY KEY,
      checksum   STRING      NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const { rows } = await client.query('SELECT version, checksum FROM schema_migrations');
  const applied = new Map(rows.map((r) => [r.version, r.checksum]));

  let ran = 0;

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
    const previous = applied.get(file);

    if (previous !== undefined) {
      if (previous === checksum) {
        console.log(`  skip     ${file}  (already applied)`);
      } else {
        console.error(`\nFATAL: ${file} has changed since it was applied.`);
        console.error(`  recorded checksum ${previous}`);
        console.error(`  current checksum  ${checksum}`);
        console.error('\nApplied migrations are immutable. Write a new migration instead.');
        process.exitCode = 1;
        break;
      }
      continue;
    }

    if (dryRun) {
      console.log(`  WOULD RUN ${file}  (${sql.length} bytes, checksum ${checksum})`);
      continue;
    }

    process.stdout.write(`  apply    ${file} ... `);
    const started = Date.now();
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
      [file, checksum],
    );
    console.log(`ok (${Date.now() - started} ms)`);
    ran += 1;
  }

  if (!dryRun) {
    console.log(`\n${ran} migration(s) applied.`);
  }
} catch (err) {
  console.error('\nFATAL:', err.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
