import type {
  ActionType,
  AircraftClass,
  CaseStatus,
  Cause,
  ConnectionStatus,
  PriorityTier,
} from '../domain/vocabulary.js';

/**
 * In-memory shapes produced by the generator, before they touch the database.
 *
 * IDs are minted client-side rather than relying on `gen_random_uuid()` so that
 * a case, its passengers, its embedding and its resolution can all be written
 * in one transaction without a round trip to read back the generated key.
 */

export interface SyntheticCase {
  id: string;
  flightNo: string;
  origin: string;
  destination: string;
  scheduledDep: Date;
  actualDep: Date | null;
  delayMinutes: number;
  cause: Cause;
  aircraftClass: AircraftClass;
  paxCount: number;
  misconnectCount: number;
  priorityPaxCount: number;
  status: CaseStatus;
  createdAt: Date;
}

export interface SyntheticPassenger {
  caseId: string;
  paxRef: string;
  priorityTier: PriorityTier;
  onwardFlight: string | null;
  connectionMinutes: number | null;
  connectionStatus: ConnectionStatus;
  rebookedTo: string | null;
  specialHandling: string[];
}

/** One entry in resolutions.actions_taken (JSONB). */
export interface ResolutionAction {
  action_type: ActionType;
  affected_pax: number;
  detail: string;
}

export interface SyntheticResolution {
  caseId: string;
  actionsTaken: ResolutionAction[];
  outcomeNotes: string;
  /** 1 = went badly, 5 = went well. */
  outcomeRating: number;
  resolvedAt: Date;
}

/** A case plus everything generated alongside it. */
export interface GeneratedCase {
  case: SyntheticCase;
  passengers: SyntheticPassenger[];
  resolution: SyntheticResolution | null;
}
