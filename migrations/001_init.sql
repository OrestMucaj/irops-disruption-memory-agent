-- =============================================================================
-- 001_init.sql — initial schema for the IROPS Disruption Memory Agent
--
-- Target: CockroachDB Cloud (Basic plan).
-- Source of truth for shape: SPEC.md §4.
-- Source of truth for syntax: NOTES.md §1 (verified against official docs
-- 2026-07-29). Every non-obvious choice below cites the note that justifies it.
--
-- THIS FILE HAS NOT BEEN RUN. No cluster exists yet. Treat the first execution
-- as a test of the file, not a formality — see "Before first run" below.
--
-- ALL DATA IS SYNTHETIC (SPEC §1.1). This schema models generic, publicly
-- documented airline operations concepts only.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Before first run
-- -----------------------------------------------------------------------------
-- The CockroachDB docs contradict each other on whether vector indexes need to
-- be switched on (NOTES.md §1.8):
--
--   * The "Vector Indexes" page says: "To enable the use of vector indexes, set
--     the feature.vector_index.enabled cluster setting".
--   * The "Cluster Settings" reference lists that same setting with a default
--     of TRUE, supported on Basic/Standard/Advanced/Self-Hosted.
--
-- The likeliest reading is that the default flipped to TRUE when the feature
-- matured and the first page still carries preview-era instructions. That is
-- inference, not documentation, so this migration does NOT silently assume it.
--
-- Run this first and look at the answer:
--
--     SHOW CLUSTER SETTING feature.vector_index.enabled;
--
-- If it is already true, do nothing. If it is false, run:
--
--     SET CLUSTER SETTING feature.vector_index.enabled = true;
--
-- If that statement is rejected on a Basic cluster, STOP. The whole retrieval
-- design depends on vector indexes and the fallback needs to be chosen
-- deliberately, not discovered halfway through M3.
--
-- The docs also show `SET sql_safe_updates = false;` alongside the above. No
-- statement in this file is blocked by sql_safe_updates, so it is not set here.
-- -----------------------------------------------------------------------------


-- -----------------------------------------------------------------------------
-- Conventions
-- -----------------------------------------------------------------------------
-- * Value sets are enforced with STRING + CHECK rather than CREATE TYPE ... AS
--   ENUM. Enums are tidier, but `case_status` below is a prefix column on a
--   vector index and the docs only ever show INT prefix columns. Putting an
--   unverified user-defined type on the critical retrieval path is not worth
--   the elegance (SPEC §10: prefer boring, working solutions).
-- * TIMESTAMPTZ everywhere, never TIMESTAMP.
-- * Random UUID primary keys via gen_random_uuid(), which is what the
--   CockroachDB docs use, and which avoids the write hotspot that sequential
--   keys create on a distributed cluster.
-- * Vectors are VECTOR(1024) to match Amazon Titan Text Embeddings V2 at its
--   default dimension (NOTES.md §4.1, §5.1). This number is duplicated in
--   EMBEDDING_DIMENSIONS in .env. Changing the embedding model is a MIGRATION,
--   not a config edit. src/config.ts fails at boot if the two disagree.
-- * Cosine distance (`<=>`) with the vector_cosine_ops opclass, everywhere
--   (NOTES.md §5.2). An index built with the default vector_l2_ops will NOT
--   accelerate a `<=>` query. Opclass and operator must match — if you change
--   one, change the other.
--
-- Columns added beyond the SPEC §4 shape, and why:
--   case_embeddings.case_status   index prefix for hybrid retrieval (§1.3)
--   case_embeddings.model_id      vectors from different models are not
--                                 comparable; you cannot debug a retrieval
--                                 regression without knowing which model
--                                 produced a given vector
--   resolutions.model_id          same reason
--   proposed_actions.agent_run_id ties a proposal to the run that produced it,
--                                 which is what makes agent_runs an audit trail
--                                 rather than a metrics table
--   proposed_actions.edited_payload  preserves what the agent proposed AND what
--                                 the human changed it to (SPEC §5.3)
--   proposed_actions.decided_at   when the human ruled on it
-- -----------------------------------------------------------------------------


-- =============================================================================
-- disruption_cases — the operational facts of one disruption
-- =============================================================================
CREATE TABLE IF NOT EXISTS disruption_cases (
    id                  UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,

    flight_no           STRING      NOT NULL,
    origin              STRING      NOT NULL,       -- IATA-style 3-letter code
    destination         STRING      NOT NULL,       -- IATA-style 3-letter code

    scheduled_dep       TIMESTAMPTZ NOT NULL,
    actual_dep          TIMESTAMPTZ,                -- NULL while still delayed/cancelled
    delay_minutes       INT,                        -- NULL when not yet known

    cause               STRING      NOT NULL,
    aircraft_type       STRING,

    pax_count           INT         NOT NULL DEFAULT 0,
    misconnect_count    INT         NOT NULL DEFAULT 0,
    priority_pax_count  INT         NOT NULL DEFAULT 0,

    status              STRING      NOT NULL DEFAULT 'open',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_cases_cause CHECK (
        cause IN ('weather', 'technical', 'crew', 'atc', 'knock_on')
    ),
    CONSTRAINT chk_cases_status CHECK (
        status IN ('open', 'planned', 'resolved')
    ),
    CONSTRAINT chk_cases_counts CHECK (
        pax_count >= 0
        AND misconnect_count >= 0
        AND priority_pax_count >= 0
        AND misconnect_count <= pax_count
        AND priority_pax_count <= pax_count
    )
);

-- Drives the case-list view (SPEC §6.1): filter by status, newest first.
CREATE INDEX IF NOT EXISTS idx_cases_status_created
    ON disruption_cases (status, created_at DESC);


-- =============================================================================
-- passengers — the misconnect picture for a case
--
-- pax_ref is a SYNTHETIC reference generated by this repo's data generator.
-- It is not, and must never be, a real booking reference (SPEC §1.1).
-- =============================================================================
CREATE TABLE IF NOT EXISTS passengers (
    id                  UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    case_id             UUID        NOT NULL
                            REFERENCES disruption_cases (id) ON DELETE CASCADE,

    pax_ref             STRING      NOT NULL,

    -- Deliberately generic, non-branded tier names. No real loyalty programme
    -- naming, here or anywhere else in the repo (SPEC §1.1).
    priority_tier       STRING      NOT NULL DEFAULT 'standard',

    onward_flight       STRING,
    connection_minutes  INT,
    connection_status   STRING      NOT NULL DEFAULT 'safe',
    rebooked_to         STRING,
    special_handling    STRING[]    NOT NULL DEFAULT ARRAY[]::STRING[],

    CONSTRAINT chk_pax_tier CHECK (
        priority_tier IN ('standard', 'priority', 'premium')
    ),
    CONSTRAINT chk_pax_connection_status CHECK (
        connection_status IN ('safe', 'at_risk', 'missed')
    ),
    CONSTRAINT uq_pax_case_ref UNIQUE (case_id, pax_ref)
);

CREATE INDEX IF NOT EXISTS idx_pax_case_connection
    ON passengers (case_id, connection_status);


-- =============================================================================
-- case_embeddings — the memory layer
--
-- One row per case. summary_text is a deterministic natural-language digest
-- generated from the case's structured fields; the embedding is of that digest.
-- Per SPEC §4, generating summary_text well is high-leverage — semantic
-- similarity operates on it, not on the raw columns.
--
-- THE HYBRID RETRIEVAL DESIGN (SPEC §5.1, NOTES.md §1.3, §5.3):
--
-- SPEC §5.1 wants precedent retrieval restricted to resolved cases while still
-- ranking by semantic similarity. A vector index in CockroachDB may carry
-- leading non-vector "prefix" columns, and it maintains a separate K-means tree
-- per distinct prefix value. Filtering on the prefix is therefore
-- index-accelerated rather than a post-filter over an ANN result set.
--
-- That is why case_status is denormalized onto this table: it exists purely to
-- be that prefix column.
--
-- THE COST: case_status duplicates disruption_cases.status and can drift. The
-- application MUST update both in the same transaction. This is not enforced by
-- a trigger — CockroachDB trigger support is recent and unverified here, and a
-- silently-wrong trigger on the retrieval path would be worse than an explicit
-- application-level contract. Drift check:
--
--     SELECT c.id FROM disruption_cases c
--     JOIN case_embeddings e ON e.case_id = c.id
--     WHERE c.status <> e.case_status;
--
-- That query should always return zero rows; it belongs in the test suite.
-- =============================================================================
CREATE TABLE IF NOT EXISTS case_embeddings (
    case_id       UUID          NOT NULL PRIMARY KEY
                        REFERENCES disruption_cases (id) ON DELETE CASCADE,

    summary_text  STRING        NOT NULL,

    -- Denormalized from disruption_cases.status. See the note above before
    -- touching this column.
    case_status   STRING        NOT NULL,

    embedding     VECTOR(1024)  NOT NULL,

    -- Which model produced this vector. Vectors from different models are not
    -- comparable, so mixing them silently corrupts retrieval.
    model_id      STRING        NOT NULL,
    embedded_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT chk_embeddings_status CHECK (
        case_status IN ('open', 'planned', 'resolved')
    ),

    -- ⚠️ VERIFY ON FIRST RUN. The docs show prefix columns and an explicit
    -- opclass in separate examples and never together:
    --     VECTOR INDEX (department_id, category_id, embedding)
    --     VECTOR INDEX embed_idx (embedding vector_cosine_ops)
    -- The line below composes the two. That composition is the natural reading
    -- of the grammar but it is NOT copied verbatim from any documented example,
    -- so it is the single most likely statement in this file to fail. If it
    -- does, fall back to a documented form and record the outcome in NOTES.md.
    VECTOR INDEX idx_case_embeddings_status_vec (case_status, embedding vector_cosine_ops)
);


-- =============================================================================
-- agent_runs — observability (SPEC §4, §5.4)
--
-- Every agent invocation lands here, INCLUDING failures. SPEC §4 calls this the
-- observability story and says explicitly not to skip it.
--
-- case_id is ON DELETE SET NULL rather than CASCADE: deleting a case should not
-- destroy the audit trail of what the agent did to it.
--
-- Declared before proposed_actions because that table references this one.
-- =============================================================================
CREATE TABLE IF NOT EXISTS agent_runs (
    id                 UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    case_id            UUID        REFERENCES disruption_cases (id) ON DELETE SET NULL,

    model_id           STRING      NOT NULL,
    prompt_tokens      INT,
    completion_tokens  INT,
    latency_ms         INT,

    -- Which precedents this run actually retrieved. Makes "why did the agent
    -- say that?" answerable after the fact.
    retrieved_case_ids UUID[]      NOT NULL DEFAULT ARRAY[]::UUID[],

    -- NULL on success. Populated on failure — a run that errored is still a run
    -- and still gets a row.
    error              STRING,

    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_case_created
    ON agent_runs (case_id, created_at DESC);

-- Supports "show me recent failures" without scanning the table.
CREATE INDEX IF NOT EXISTS idx_agent_runs_errors
    ON agent_runs (created_at DESC)
    WHERE error IS NOT NULL;


-- =============================================================================
-- proposed_actions — what the agent suggested, and what the human did about it
--
-- No action here is ever auto-executed (SPEC §5.4). This table is a proposal
-- log plus a decision log; nothing downstream acts on a row in 'proposed'.
--
-- Rejections and edits are retained deliberately (SPEC §5.3): what a human
-- overruled is the strongest signal in the dataset.
-- =============================================================================
CREATE TABLE IF NOT EXISTS proposed_actions (
    id                 UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    case_id            UUID        NOT NULL
                            REFERENCES disruption_cases (id) ON DELETE CASCADE,

    -- The run that produced this proposal.
    agent_run_id       UUID        REFERENCES agent_runs (id) ON DELETE SET NULL,

    action_type        STRING      NOT NULL,
    target_pax_ref     STRING,                     -- NULL for case-level actions

    -- What the agent proposed. Never mutated after insert.
    payload            JSONB       NOT NULL DEFAULT '{}'::JSONB,

    -- Populated only when status = 'edited': what the human changed it to.
    -- Keeping both is the point — the delta between them is the training
    -- signal, and throwing away the original would destroy it.
    edited_payload     JSONB,

    rationale          STRING,

    -- Which past cases the agent cited. Precedent without attribution is not
    -- reviewable.
    precedent_case_ids UUID[]      NOT NULL DEFAULT ARRAY[]::UUID[],

    confidence         FLOAT8,

    status             STRING      NOT NULL DEFAULT 'proposed',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at         TIMESTAMPTZ,                -- NULL while status='proposed'

    CONSTRAINT chk_actions_type CHECK (
        action_type IN ('rebook', 'prioritise', 'hotel', 'notify', 'escalate')
    ),
    CONSTRAINT chk_actions_status CHECK (
        status IN ('proposed', 'approved', 'rejected', 'edited')
    ),
    CONSTRAINT chk_actions_confidence CHECK (
        confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
    ),
    -- An edited action must carry the edit; an un-edited one must not.
    CONSTRAINT chk_actions_edit_payload CHECK (
        (status = 'edited' AND edited_payload IS NOT NULL)
        OR (status <> 'edited' AND edited_payload IS NULL)
    ),
    -- A decided action must record when. An undecided one must not.
    CONSTRAINT chk_actions_decided_at CHECK (
        (status = 'proposed' AND decided_at IS NULL)
        OR (status <> 'proposed' AND decided_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_actions_case_status
    ON proposed_actions (case_id, status, created_at DESC);

-- Powers the "most-cited precedents" panel in the memory view (SPEC §6.3).
CREATE INVERTED INDEX IF NOT EXISTS idx_actions_precedents
    ON proposed_actions (precedent_case_ids);


-- =============================================================================
-- resolutions — what was actually done, and how it turned out
--
-- This is the half of memory that makes precedent useful. SPEC §5.1: "Precedent
-- without outcome is useless." Retrieval joins through to this table.
--
-- embedding is NULLABLE on purpose. Recording that a case was resolved must not
-- fail because Bedrock was unavailable — an unembedded resolution is still a
-- true operational record, it just is not yet retrievable as precedent. The
-- backfill path is:
--
--     SELECT id, case_id FROM resolutions WHERE embedding IS NULL;
--
-- Where the embedding IS available, write it in the same transaction as the
-- resolution row. That is the SPEC §4 design point: no ETL, no consistency gap
-- between what the agent remembers and what actually happened.
-- =============================================================================
CREATE TABLE IF NOT EXISTS resolutions (
    id             UUID          NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    case_id        UUID          NOT NULL
                        REFERENCES disruption_cases (id) ON DELETE CASCADE,

    actions_taken  JSONB         NOT NULL DEFAULT '[]'::JSONB,
    outcome_notes  STRING,

    -- 1 = went badly, 5 = went well. Human-supplied.
    outcome_rating INT2,

    resolved_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),

    embedding      VECTOR(1024),
    model_id       STRING,                         -- NULL iff embedding IS NULL

    CONSTRAINT chk_resolutions_rating CHECK (
        outcome_rating IS NULL OR (outcome_rating >= 1 AND outcome_rating <= 5)
    ),
    CONSTRAINT chk_resolutions_model_id CHECK (
        (embedding IS NULL AND model_id IS NULL)
        OR (embedding IS NOT NULL AND model_id IS NOT NULL)
    ),

    -- ⚠️ VERIFY ON FIRST RUN, two things:
    --   1. the prefix-plus-opclass composition, as on case_embeddings above;
    --   2. that a vector index tolerates NULLs in the indexed column. The docs
    --      say nothing either way (NOTES.md). If NULLs are rejected, the fix is
    --      to make embedding NOT NULL and embed before insert — which costs the
    --      graceful-degradation property described above, so make that trade
    --      knowingly rather than by accident.
    VECTOR INDEX idx_resolutions_vec (embedding vector_cosine_ops)
);

CREATE INDEX IF NOT EXISTS idx_resolutions_case
    ON resolutions (case_id, resolved_at DESC);

-- Powers the "recent resolutions" panel in the memory view (SPEC §6.3).
CREATE INDEX IF NOT EXISTS idx_resolutions_resolved_at
    ON resolutions (resolved_at DESC);


-- =============================================================================
-- Post-migration sanity checks — run these by hand after first execution
-- =============================================================================
-- 1. Vector index exists and is the type you think it is:
--        SHOW INDEXES FROM case_embeddings;
--
-- 2. The retrieval query is actually index-accelerated. This is the one that
--    matters — if it shows a full scan, the memory layer is a lie and every
--    performance claim in the README is wrong:
--
--        EXPLAIN
--        SELECT case_id, summary_text
--        FROM case_embeddings
--        WHERE case_status = 'resolved'
--        ORDER BY embedding <=> $1
--        LIMIT 5;
--
--    Note `<=>`, matching vector_cosine_ops. Note the query vector is bound as
--    a parameter, not interpolated (SPEC §5.4: parameterised queries only).
--
-- 3. Dimension guard — this should ERROR, proving VECTOR(1024) is enforced:
--        INSERT INTO case_embeddings (case_id, summary_text, case_status,
--                                     embedding, model_id)
--        VALUES (gen_random_uuid(), 'x', 'open', '[1,2,3]', 'test');
-- =============================================================================
