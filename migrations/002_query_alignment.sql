-- =============================================================================
-- 002_query_alignment.sql
--
-- Applies two findings from the CockroachDB Agent Skills repo
-- (github.com/cockroachlabs/cockroachdb-skills), 2026-08-04:
--   * cockroachdb-query-and-schema-design/cockroachdb-sql
--   * cockroachdb-observability-and-diagnostics/auditing-table-statistics
--
-- Both were caught by EXPLAIN, not by reading the code.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- FINDING 1: the case-list index could never serve the case-list query.
--
-- 001_init.sql created:
--     idx_cases_status_created ON disruption_cases (status, created_at DESC)
--
-- but the query the API actually runs orders by scheduled_dep, not created_at:
--
--     ORDER BY CASE status WHEN 'open' THEN 0 ... END, scheduled_dep DESC
--
-- Different column, so the index is unusable for the ordering and EXPLAIN
-- showed a FULL SCAN on the hottest read in the app. The index was written
-- from an assumption about how the list would be sorted; the API was written
-- later and sorted by something else. Nothing errors when these disagree — you
-- just quietly get a scan.
--
-- The STORING clause is the optimizer's own recommendation, and matches the
-- skill's guidance ("Add STORING to indexes for covering queries"): it carries
-- the columns the list renders, so the read never returns to the primary index.
--
-- HONEST SCOPE: at 84 rows a full scan is microseconds and this changes nothing
-- measurable. It is applied because the mismatch was a real defect and the fix
-- is free, not because the demo is slow.
-- -----------------------------------------------------------------------------

DROP INDEX IF EXISTS idx_cases_status_created;

CREATE INDEX IF NOT EXISTS idx_cases_status_dep
    ON disruption_cases (status, scheduled_dep DESC)
    STORING (flight_no, origin, destination, delay_minutes, cause,
             pax_count, misconnect_count, priority_pax_count);


-- -----------------------------------------------------------------------------
-- FINDING 2: the optimizer was planning against stale row counts.
--
-- SHOW STATISTICS reported disruption_cases at 52 rows (actual: 84) and
-- case_embeddings at 0 rows (actual: 84), collected 18 hours earlier. Automatic
-- statistics had not caught up with the bulk seed.
--
-- This also retroactively explains a note in NOTES.md §1.10. During M1 the
-- optimizer recommended a plain covering index on case_embeddings(case_status)
-- that would have replaced vector search with a scan, and that recommendation
-- was ignored on the grounds that "the tables are empty, so the optimizer has
-- no statistics". SHOW STATISTICS confirms it: the row count really was 0.
--
-- ANALYZE is a synchronous refresh. src/seed/run.ts now runs it after seeding,
-- which is where the drift actually originates — a bulk load that automatic
-- statistics has not yet noticed.
-- -----------------------------------------------------------------------------

ANALYZE disruption_cases;
ANALYZE case_embeddings;
ANALYZE passengers;
ANALYZE resolutions;
ANALYZE proposed_actions;
ANALYZE agent_runs;
