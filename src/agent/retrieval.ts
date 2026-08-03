import type pg from 'pg';

import { toVectorLiteral } from '../db.js';
import { buildCaseSummary } from '../domain/summary.js';
import type {
  AircraftClass,
  CaseFacts,
  CaseStatus,
  Cause,
  ConnectionStatus,
  PassengerFacts,
  PriorityTier,
} from '../domain/vocabulary.js';
import type { EmbeddingProvider } from '../providers/index.js';

/**
 * Precedent retrieval — SPEC §5.1.
 *
 * The one thing to understand here: this is a **hybrid** query. The
 * `case_status = 'resolved'` filter is not applied after the fact to an
 * approximate-nearest-neighbour result set; it is a prefix span inside the
 * vector index itself (NOTES.md §1.3, §1.10). That is what makes "only cases
 * that actually finished, ranked by similarity" a single indexed operation
 * rather than two passes that fight each other.
 *
 * And precedent is joined through to its outcome. SPEC §5.1 is blunt about why:
 * a similar case whose result you do not know is not precedent, it is trivia.
 */

const AIRCRAFT_CLASSES: readonly AircraftClass[] = [
  'turboprop', 'regional_jet', 'narrow_body', 'wide_body',
];
const CAUSES: readonly Cause[] = ['weather', 'technical', 'crew', 'atc', 'knock_on'];

export interface CaseRecord extends CaseFacts {
  readonly id: string;
  readonly actualDep: Date | null;
  readonly status: CaseStatus;
  readonly createdAt: Date;
}

export interface PassengerRecord extends PassengerFacts {
  readonly paxRef: string;
  readonly priorityTier: PriorityTier;
  readonly onwardFlight: string | null;
  readonly connectionMinutes: number | null;
  readonly rebookedTo: string | null;
}

export interface PrecedentOutcome {
  readonly actionsTaken: ReadonlyArray<{ action_type: string; affected_pax: number; detail?: string }>;
  readonly outcomeNotes: string | null;
  readonly outcomeRating: number | null;
  readonly resolvedAt: Date;
}

export interface Precedent {
  readonly caseId: string;
  readonly summaryText: string;
  readonly distance: number;
  readonly cause: Cause;
  readonly delayMinutes: number;
  readonly scheduledDep: Date;
  readonly outcome: PrecedentOutcome | null;
}

export interface RetrievalResult {
  readonly subject: CaseRecord;
  readonly passengers: readonly PassengerRecord[];
  /** Built by the SAME code path that summarised the seeded cases. */
  readonly summaryText: string;
  readonly embedding: readonly number[];
  readonly precedents: readonly Precedent[];
}

export async function loadCase(
  db: pg.Pool | pg.PoolClient,
  caseId: string,
): Promise<{ subject: CaseRecord; passengers: PassengerRecord[] } | null> {
  const caseRows = await db.query(
    `SELECT id::STRING AS id, flight_no, origin, destination, scheduled_dep,
            actual_dep, delay_minutes, cause, aircraft_type, pax_count,
            misconnect_count, priority_pax_count, status, created_at
       FROM disruption_cases WHERE id = $1`,
    [caseId],
  );

  const row = caseRows.rows[0];
  if (row === undefined) return null;

  const subject: CaseRecord = {
    id: String(row.id),
    flightNo: String(row.flight_no),
    origin: String(row.origin),
    destination: String(row.destination),
    scheduledDep: new Date(row.scheduled_dep),
    actualDep: row.actual_dep === null ? null : new Date(row.actual_dep),
    delayMinutes: Number(row.delay_minutes ?? 0),
    cause: assertOneOf(row.cause, CAUSES, 'cause'),
    aircraftClass: assertOneOf(row.aircraft_type, AIRCRAFT_CLASSES, 'aircraft_type'),
    paxCount: Number(row.pax_count),
    misconnectCount: Number(row.misconnect_count),
    priorityPaxCount: Number(row.priority_pax_count),
    status: row.status as CaseStatus,
    createdAt: new Date(row.created_at),
  };

  const paxRows = await db.query(
    `SELECT pax_ref, priority_tier, onward_flight, connection_minutes,
            connection_status, rebooked_to, special_handling
       FROM passengers
      WHERE case_id = $1
      ORDER BY
        CASE connection_status WHEN 'missed' THEN 0 WHEN 'at_risk' THEN 1 ELSE 2 END,
        connection_minutes NULLS LAST,
        pax_ref`,
    [caseId],
  );

  const passengers: PassengerRecord[] = paxRows.rows.map((p) => ({
    paxRef: String(p.pax_ref),
    priorityTier: p.priority_tier as PriorityTier,
    onwardFlight: p.onward_flight === null ? null : String(p.onward_flight),
    connectionMinutes: p.connection_minutes === null ? null : Number(p.connection_minutes),
    connectionStatus: p.connection_status as ConnectionStatus,
    rebookedTo: p.rebooked_to === null ? null : String(p.rebooked_to),
    specialHandling: Array.isArray(p.special_handling) ? p.special_handling.map(String) : [],
  }));

  return { subject, passengers };
}

export async function retrievePrecedents(
  db: pg.Pool | pg.PoolClient,
  embedder: EmbeddingProvider,
  caseId: string,
  topK: number,
): Promise<RetrievalResult> {
  const loaded = await loadCase(db, caseId);
  if (loaded === null) {
    throw new Error(`case ${caseId} not found`);
  }

  const { subject, passengers } = loaded;
  const summaryText = buildCaseSummary(subject, passengers);
  const embedding = await embedder.embed(summaryText);

  // The hybrid query. `case_status = 'resolved'` is the vector index prefix,
  // and `<=>` must match the vector_cosine_ops opclass the index was built with
  // -- swapping in `<->` here would silently stop using the index.
  const { rows } = await db.query(
    `SELECT e.case_id::STRING       AS case_id,
            e.summary_text          AS summary_text,
            e.embedding <=> $1      AS distance,
            c.cause                 AS cause,
            c.delay_minutes         AS delay_minutes,
            c.scheduled_dep         AS scheduled_dep,
            r.actions_taken         AS actions_taken,
            r.outcome_notes         AS outcome_notes,
            r.outcome_rating        AS outcome_rating,
            r.resolved_at           AS resolved_at
       FROM case_embeddings e
       JOIN disruption_cases c ON c.id = e.case_id
       LEFT JOIN resolutions r ON r.case_id = e.case_id
      WHERE e.case_status = 'resolved'
        AND e.case_id <> $2
      ORDER BY e.embedding <=> $1
      LIMIT $3`,
    [toVectorLiteral(embedding), caseId, topK],
  );

  const precedents: Precedent[] = rows.map((row) => ({
    caseId: String(row.case_id),
    summaryText: String(row.summary_text),
    distance: Number(row.distance),
    cause: assertOneOf(row.cause, CAUSES, 'cause'),
    delayMinutes: Number(row.delay_minutes ?? 0),
    scheduledDep: new Date(row.scheduled_dep),
    outcome: row.resolved_at === null
      ? null
      : {
          actionsTaken: Array.isArray(row.actions_taken) ? row.actions_taken : [],
          outcomeNotes: row.outcome_notes === null ? null : String(row.outcome_notes),
          outcomeRating: row.outcome_rating === null ? null : Number(row.outcome_rating),
          resolvedAt: new Date(row.resolved_at),
        },
  }));

  return { subject, passengers, summaryText, embedding, precedents };
}

/**
 * Narrows a database string to a union member.
 *
 * The CHECK constraints in 001_init.sql already guarantee these values, so this
 * should never throw. It exists so that a schema change which widens a CHECK
 * without updating the TypeScript union fails loudly here rather than flowing
 * an unexpected string into a lookup table and producing `undefined` in a
 * prompt.
 */
function assertOneOf<T extends string>(value: unknown, allowed: readonly T[], column: string): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new Error(
      `${column}: database returned "${String(value)}", which is not one of ${allowed.join(' | ')}. ` +
        'The schema and the TypeScript union have diverged.',
    );
  }
  return found;
}
