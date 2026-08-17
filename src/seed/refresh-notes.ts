/**
 * Backfills outcome notes on an already-seeded database.
 *
 * The note bank in generate.ts produced 81 resolutions carrying 13 distinct
 * strings — three of them fifteen times each. Fixing the generator only helps
 * a fresh seed, and re-seeding would mint new case ids and invalidate every
 * embedding and every agent run already recorded. So this rewrites the prose
 * in place and leaves everything else exactly as it was.
 *
 * Only the five known boilerplate strings are replaced, matched exactly. The
 * failure notes ("No triage was applied, so passengers were handled
 * first-come-first-served…") were already specific, already read like a real
 * post-mortem, and are the ones that surface on the low-rated precedent a
 * reviewer most needs to see. Those are not touched.
 *
 * Ratings, actions_taken, resolved_at and case ids are left alone: the rating
 * is the ground truth the retrieval evaluation scores against, and rewriting it
 * would be changing the answer to make the prose fit.
 *
 *   npm run refresh:notes           # apply
 *   npm run refresh:notes -- --dry  # preview without writing
 */
import pg from 'pg';
import { createPool, withTransaction } from '../db.js';
import { loadConfig } from '../config.js';
import { LEGACY_SUCCESS_NOTES, composeOutcomeNote } from '../domain/outcome-notes.js';

interface Row {
  case_id: string;
  outcome_notes: string;
  outcome_rating: number;
  cause: string;
  delay_minutes: number;
  pax_count: number;
  misconnect_count: number;
  priority_pax_count: number;
  actions_taken: Array<{ action_type?: string }> | null;
}

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry');
  const config = loadConfig();
  const pool = createPool(config);

  const { rows } = await pool.query<Row>(
    `SELECT r.case_id::STRING AS case_id, r.outcome_notes, r.outcome_rating, r.actions_taken,
            c.cause, c.delay_minutes, c.pax_count, c.misconnect_count, c.priority_pax_count
       FROM resolutions r
       JOIN disruption_cases c ON c.id = r.case_id
      ORDER BY r.resolved_at`,
  );

  const legacy = new Set(LEGACY_SUCCESS_NOTES);
  const updates: Array<{ caseId: string; before: string; after: string }> = [];

  for (const row of rows) {
    if (!legacy.has(row.outcome_notes.trim())) continue;
    const after = composeOutcomeNote(row.case_id, {
      cause: String(row.cause),
      delayMinutes: Number(row.delay_minutes),
      paxCount: Number(row.pax_count),
      misconnectCount: Number(row.misconnect_count),
      priorityPaxCount: Number(row.priority_pax_count),
      actionsTaken: (row.actions_taken ?? [])
        .map((a) => String(a.action_type ?? ''))
        .filter((a) => a !== ''),
      outcomeRating: Number(row.outcome_rating),
    });
    updates.push({ caseId: row.case_id, before: row.outcome_notes, after });
  }

  console.log(`resolutions           : ${rows.length}`);
  console.log(`boilerplate to replace: ${updates.length}`);
  console.log(`left untouched        : ${rows.length - updates.length} (specific notes, mostly failures)`);

  const distinctBefore = new Set(rows.map((r) => r.outcome_notes)).size;
  const afterAll = rows.map((r) => {
    const u = updates.find((x) => x.caseId === r.case_id);
    return u === undefined ? r.outcome_notes : u.after;
  });
  const distinctAfter = new Set(afterAll).size;
  console.log(`distinct strings      : ${distinctBefore} -> ${distinctAfter}`);

  console.log('\nsample:');
  for (const u of updates.slice(0, 3)) {
    console.log(`  before: ${u.before}`);
    console.log(`  after : ${u.after}\n`);
  }

  if (dry) {
    console.log('--dry: nothing written.');
    await pool.end();
    return;
  }

  // One transaction: a half-rewritten memory is worse than an unrewritten one.
  await withTransaction(pool, async (client: pg.PoolClient) => {
    for (const u of updates) {
      await client.query(
        `UPDATE resolutions SET outcome_notes = $2 WHERE case_id = $1`,
        [u.caseId, u.after],
      );
    }
  }, { label: 'refresh-notes' });

  console.log(`\nwrote ${updates.length} notes.`);
  console.log('resolutions.embedding is now stale for those rows — re-embed if it is used in retrieval.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
