import {
  CARRIER_CODE,
  HUBS,
  LONG_HAUL,
  OUTSTATIONS,
  PAX_REF_PREFIX,
  SPECIAL_HANDLING,
  misconnectPressureOf,
  recoveryWindowOf,
  seatRange,
  severityOf,
  stationTypeOf,
} from '../domain/vocabulary.js';
import type {
  ActionType,
  AircraftClass,
  CaseFacts,
  Cause,
  ConnectionStatus,
  PassengerFacts,
  PriorityTier,
} from '../domain/vocabulary.js';
import { Rng } from './random.js';
import { composeOutcomeNote } from '../domain/outcome-notes.js';
import type {
  GeneratedCase,
  ResolutionAction,
  SyntheticCase,
  SyntheticPassenger,
  SyntheticResolution,
} from './types.js';

/**
 * Synthetic historical disruption generator.
 *
 * ALL DATA IS INVENTED (SPEC §1.1). See domain.ts for the provenance rules.
 *
 * The point of this file is not to produce plausible-looking rows. It is to
 * produce a corpus that contains a **learnable pattern**, because a memory
 * layer whose history is noise cannot demonstrate memory. Concretely: the
 * right response to a disruption is largely determined by its cause, its
 * severity, and — most of all — the hour it happened, and the generator encodes
 * that relationship, then deviates from it in a minority of cases and records
 * the worse outcome that followed.
 *
 * That gives retrieval something real to surface: not just "here is a similar
 * case" but "here is a similar case, here is what was done, and here is why it
 * did or did not work".
 */

/** How many passenger rows to store per case, at most. */
const MAX_STORED_PASSENGERS = 30;

/** Share of historical cases where the desk did NOT follow the playbook. */
const MISHANDLED_SHARE = 0.28;

export interface GenerateOptions {
  seed: number;
  resolvedCases: number;
  openCases: number;
  /** Newest case is this many days before `now`. */
  endDaysAgo?: number;
  /** Oldest case is this many days before `now`. */
  startDaysAgo?: number;
  now?: Date;
}

export function generateDataset(options: GenerateOptions): GeneratedCase[] {
  const {
    seed,
    resolvedCases,
    openCases,
    endDaysAgo = 3,
    startDaysAgo = 540,
    now = new Date('2026-07-29T00:00:00Z'),
  } = options;

  const rng = new Rng(seed);
  const out: GeneratedCase[] = [];

  for (let i = 0; i < resolvedCases + openCases; i += 1) {
    const isOpen = i >= resolvedCases;
    const daysAgo = isOpen
      ? rng.int(0, endDaysAgo)
      : rng.int(endDaysAgo, startDaysAgo);

    const disruption = generateCase(rng, now, daysAgo, isOpen);
    const passengers = generatePassengers(rng, disruption);
    const resolution = isOpen ? null : generateResolution(rng, disruption, passengers);

    out.push({ case: disruption, passengers, resolution });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

function generateCase(rng: Rng, now: Date, daysAgo: number, isOpen: boolean): SyntheticCase {
  const cause = rng.weighted<Cause>([
    ['weather', 30],
    ['technical', 22],
    ['knock_on', 20],
    ['crew', 16],
    ['atc', 12],
  ]);

  const aircraftClass = rng.weighted<AircraftClass>([
    ['narrow_body', 50],
    ['regional_jet', 25],
    ['wide_body', 15],
    ['turboprop', 10],
  ]);

  const [origin, destination] = generateRoute(rng, aircraftClass);

  // Scheduled departure. Hours are weighted towards a realistic operating day,
  // but late departures are over-represented relative to reality because they
  // are the operationally interesting ones -- that is where the recovery
  // window actually bites.
  const hour = rng.weighted<number>([
    [6, 10], [7, 12], [8, 10], [9, 8], [10, 8], [11, 7], [12, 7],
    [13, 7], [14, 7], [15, 8], [16, 9], [17, 11], [18, 12], [19, 12],
    [20, 11], [21, 9], [22, 6], [23, 3],
  ]);

  const scheduledDep = new Date(now.getTime() - daysAgo * 86_400_000);
  scheduledDep.setUTCHours(hour, rng.weighted([[0, 3], [5, 2], [10, 2], [15, 2], [20, 2], [25, 1], [30, 3], [35, 1], [40, 2], [45, 2], [50, 2], [55, 2]]), 0, 0);

  const delayMinutes = generateDelay(rng, cause);

  const [minSeats, maxSeats] = seatRange(aircraftClass);
  const seats = rng.int(minSeats, maxSeats);
  const loadFactor = rng.float(0.68, 0.98);
  const paxCount = Math.max(1, Math.round(seats * loadFactor));

  // Misconnections scale with delay severity, and are far higher out of a hub
  // where most of the cabin is connecting onwards.
  const connectingShare = stationTypeOf(destination) === 'hub'
    ? rng.float(0.35, 0.7)
    : rng.float(0.05, 0.25);

  const severity = severityOf(delayMinutes);
  const missShare = severity === 'minor' ? rng.float(0, 0.15)
    : severity === 'moderate' ? rng.float(0.1, 0.45)
    : severity === 'severe' ? rng.float(0.4, 0.85)
    : rng.float(0.75, 1);

  const misconnectCount = Math.min(
    paxCount,
    Math.round(paxCount * connectingShare * missShare),
  );

  const priorityPaxCount = Math.min(
    paxCount,
    Math.round(paxCount * rng.float(0.02, 0.09)),
  );

  const actualDep = isOpen
    ? null
    : new Date(scheduledDep.getTime() + delayMinutes * 60_000);

  return {
    id: uuid(rng),
    flightNo: `${CARRIER_CODE}${rng.int(100, 4999)}`,
    origin,
    destination,
    scheduledDep,
    actualDep,
    delayMinutes,
    cause,
    aircraftClass,
    paxCount,
    misconnectCount,
    priorityPaxCount,
    status: isOpen ? (rng.bool(0.4) ? 'planned' : 'open') : 'resolved',
    createdAt: new Date(scheduledDep.getTime() - rng.int(30, 240) * 60_000),
  };
}

function generateRoute(rng: Rng, aircraft: AircraftClass): [string, string] {
  // Wide-bodies fly long-haul; turboprops never do.
  if (aircraft === 'wide_body' && rng.bool(0.75)) {
    const hub = rng.pick(HUBS);
    const far = rng.pick(LONG_HAUL);
    return rng.bool(0.5) ? [hub, far] : [far, hub];
  }

  const hub = rng.pick(HUBS);
  const spoke = rng.pick(OUTSTATIONS);
  return rng.bool(0.5) ? [hub, spoke] : [spoke, hub];
}

function generateDelay(rng: Rng, cause: Cause): number {
  // Each cause has its own characteristic shape. Technical faults are either
  // quick or catastrophic; ATC restrictions are usually short; weather is the
  // long tail.
  switch (cause) {
    case 'atc':
      return rng.normalInt(55, 40, 15, 180);
    case 'knock_on':
      return rng.normalInt(85, 55, 20, 300);
    case 'crew':
      return rng.normalInt(120, 80, 25, 420);
    case 'technical':
      return rng.bool(0.55)
        ? rng.normalInt(70, 45, 20, 180)
        : rng.normalInt(260, 120, 120, 600);
    case 'weather':
      return rng.normalInt(150, 110, 20, 600);
  }
}

// ---------------------------------------------------------------------------
// Passengers
//
// Only the operationally relevant passengers are stored, not the whole cabin.
// An IROPS desk works the misconnect list; storing 200 comfortable passengers
// per case would be 20k rows of noise and would bloat a free-tier cluster for
// no benefit. `disruption_cases.pax_count` still records the true load.
// ---------------------------------------------------------------------------

function generatePassengers(rng: Rng, disruption: SyntheticCase): SyntheticPassenger[] {
  const affected = Math.min(disruption.misconnectCount, MAX_STORED_PASSENGERS);
  const safeSample = Math.min(
    rng.int(2, 5),
    Math.max(0, MAX_STORED_PASSENGERS - affected),
  );

  const passengers: SyntheticPassenger[] = [];
  const severity = severityOf(disruption.delayMinutes);

  // passengers has UNIQUE (case_id, pax_ref). Random six-digit refs collide
  // rarely but not never, and a unique-violation halfway through a seed run is
  // an annoying way to find that out.
  const usedRefs = new Set<string>();
  const nextPaxRef = (): string => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = `${PAX_REF_PREFIX}-${String(rng.int(0, 999_999)).padStart(6, '0')}`;
      if (!usedRefs.has(candidate)) {
        usedRefs.add(candidate);
        return candidate;
      }
    }
    throw new Error('could not generate a unique pax_ref after 50 attempts');
  };

  for (let i = 0; i < affected + safeSample; i += 1) {
    const isAffected = i < affected;

    const connectionStatus: ConnectionStatus = isAffected
      ? (severity === 'extreme' || severity === 'severe'
          ? (rng.bool(0.8) ? 'missed' : 'at_risk')
          : (rng.bool(0.45) ? 'missed' : 'at_risk'))
      : 'safe';

    // Connection buffer: missed connections had short buffers, safe ones long.
    const connectionMinutes = connectionStatus === 'safe'
      ? rng.int(120, 300)
      : connectionStatus === 'at_risk'
        ? rng.int(45, 95)
        : rng.int(25, 70);

    const priorityTier = rng.weighted<PriorityTier>([
      ['standard', 78],
      ['priority', 16],
      ['premium', 6],
    ]);

    const specialHandling: string[] = [];
    if (rng.bool(0.12)) {
      specialHandling.push(rng.pick(SPECIAL_HANDLING));
      if (rng.bool(0.15)) specialHandling.push(rng.pick(SPECIAL_HANDLING));
    }

    passengers.push({
      caseId: disruption.id,
      paxRef: nextPaxRef(),
      priorityTier,
      onwardFlight: connectionStatus === 'safe' && rng.bool(0.3)
        ? null
        : `${CARRIER_CODE}${rng.int(100, 4999)}`,
      connectionMinutes,
      connectionStatus,
      // Whether they were actually rebooked is decided by the resolution below;
      // filled in there so the two cannot disagree.
      rebookedTo: null,
      specialHandling: [...new Set(specialHandling)],
    });
  }

  return passengers;
}

// ---------------------------------------------------------------------------
// Resolutions — where the learnable pattern lives
// ---------------------------------------------------------------------------

/**
 * The playbook: what a competent desk *should* do, given the shape of the case.
 *
 * This is deliberately simple and legible, because it is the ground truth the
 * agent is supposed to rediscover from precedent. If it were subtle, a
 * successful demo would prove nothing -- you could not tell whether retrieval
 * worked or the model got lucky.
 *
 * EXPORTED because src/eval/ scores the agent against it. That makes the
 * evaluation honest about what it measures: this function generated the
 * historical outcomes, so scoring against it asks "did the agent recover the
 * rule that produced this corpus from precedent alone?" -- a real question with
 * a knowable answer. It emphatically does NOT ask "is the agent right about
 * airline operations", which no synthetic benchmark can answer.
 *
 * Parameters are structural (CaseFacts / PassengerFacts) rather than the
 * generator's own types, so a case read back from the database can be scored
 * without conversion.
 */
export function idealActions(
  disruption: CaseFacts,
  passengers: readonly PassengerFacts[],
): Set<ActionType> {
  const severity = severityOf(disruption.delayMinutes);
  const window = recoveryWindowOf(disruption.scheduledDep);
  const pressure = misconnectPressureOf(disruption.misconnectCount, disruption.paxCount);
  const originType = stationTypeOf(disruption.origin);

  const actions = new Set<ActionType>();

  // Always tell people what is happening.
  actions.add('notify');

  // Anyone who has actually missed a connection needs rebooking.
  if (passengers.some((p) => p.connectionStatus === 'missed')) {
    actions.add('rebook');
  }

  // THE headline rule: a long delay late in the day strands people overnight.
  // Hour of day matters more than delay length here.
  const strandedOvernight =
    (window === 'evening' || window === 'overnight') &&
    (severity === 'severe' || severity === 'extreme') &&
    disruption.misconnectCount > 0;
  if (strandedOvernight) {
    actions.add('hotel');
  }

  // Triage only earns its keep when there are too many people to handle at once
  // and some of them outrank others.
  if (
    (pressure === 'significant' || pressure === 'widespread') &&
    disruption.priorityPaxCount > 0
  ) {
    actions.add('prioritise');
  }

  // A technical fault away from base has no engineering cover; someone with
  // authority has to make a call about the aircraft.
  if (disruption.cause === 'technical' && originType === 'outstation' && severity !== 'minor') {
    actions.add('escalate');
  }

  return actions;
}

function generateResolution(
  rng: Rng,
  disruption: SyntheticCase,
  passengers: SyntheticPassenger[],
): SyntheticResolution {
  const ideal = idealActions(disruption, passengers);
  const taken = new Set(ideal);
  const failures: string[] = [];

  const mishandled = rng.bool(MISHANDLED_SHARE);

  if (mishandled) {
    // Two distinct ways to get it wrong, and they are not symmetric: omitting
    // something necessary hurts passengers, whereas adding something
    // unnecessary just wastes capacity. The ratings below reflect that.
    if (rng.bool(0.65) && ideal.size > 1) {
      const droppable = [...ideal].filter((a) => a !== 'notify');
      if (droppable.length > 0) {
        const dropped = rng.pick(droppable);
        taken.delete(dropped);
        failures.push(omissionNote(dropped));
      }
    } else {
      const candidates: ActionType[] = (['hotel', 'escalate', 'prioritise', 'rebook'] as const)
        .filter((a) => !ideal.has(a));
      if (candidates.length > 0) {
        const added = rng.pick(candidates);
        taken.add(added);
        failures.push(overreachNote(added));
      }
    }
  }

  const rating = scoreOutcome(ideal, taken, failures.length > 0, rng);

  // Rebooking is the only action that changes passenger rows, so keep the two
  // consistent: if the desk did not rebook, nobody has a rebooked_to value.
  if (taken.has('rebook')) {
    for (const p of passengers) {
      if (p.connectionStatus === 'missed' || (p.connectionStatus === 'at_risk' && rng.bool(0.5))) {
        p.rebookedTo = `${CARRIER_CODE}${rng.int(100, 4999)}`;
      }
    }
  }

  const missedCount = passengers.filter((p) => p.connectionStatus === 'missed').length;
  const atRiskCount = passengers.filter((p) => p.connectionStatus === 'at_risk').length;

  const actionsTaken: ResolutionAction[] = [...taken].map((action) => ({
    action_type: action,
    affected_pax: affectedCountFor(action, disruption, missedCount, atRiskCount),
    detail: actionDetail(action, disruption),
  }));

  const notes = failures.length > 0
    ? failures.join(' ')
    : successNote(disruption, taken, missedCount, rating);

  const resolvedAt = new Date(
    (disruption.actualDep ?? disruption.scheduledDep).getTime() + rng.int(60, 2880) * 60_000,
  );

  return {
    caseId: disruption.id,
    actionsTaken,
    outcomeNotes: notes,
    outcomeRating: rating,
    resolvedAt,
  };
}

function scoreOutcome(
  ideal: ReadonlySet<ActionType>,
  taken: ReadonlySet<ActionType>,
  deviated: boolean,
  rng: Rng,
): number {
  if (!deviated) {
    return rng.weighted([[5, 45], [4, 45], [3, 10]]);
  }

  const missing = [...ideal].filter((a) => !taken.has(a));
  // Failing to accommodate stranded passengers overnight is the worst outcome
  // in this dataset, and the ratings need to say so clearly enough that
  // retrieval can surface it as a cautionary precedent.
  if (missing.includes('hotel')) return rng.weighted([[1, 60], [2, 40]]);
  if (missing.includes('rebook')) return rng.weighted([[1, 35], [2, 65]]);
  if (missing.length > 0) return rng.weighted([[2, 45], [3, 55]]);

  // Over-reaction: nobody was harmed, but capacity and money were burned.
  return rng.weighted([[3, 65], [2, 35]]);
}

function omissionNote(action: ActionType): string {
  switch (action) {
    case 'hotel':
      return 'No overnight accommodation was arranged; passengers were left in the terminal until the morning and complaint volume was heavy.';
    case 'rebook':
      return 'Misconnecting passengers were not proactively rebooked; most were reaccommodated only after queueing at the transfer desk.';
    case 'prioritise':
      return 'No triage was applied, so passengers were handled first-come-first-served and several priority passengers missed onward options.';
    case 'escalate':
      return 'The decision was not escalated, and the aircraft was held far longer than necessary before a call was made.';
    case 'notify':
      return 'Passengers were not notified proactively and learned of the disruption at the gate.';
  }
}

function overreachNote(action: ActionType): string {
  switch (action) {
    case 'hotel':
      return 'Overnight accommodation was booked although same-day recovery options existed, at avoidable cost.';
    case 'rebook':
      return 'Passengers were rebooked away from a flight that ultimately departed in time to hold most connections, releasing seats unnecessarily.';
    case 'prioritise':
      return 'A full triage exercise was run for a handful of affected passengers, delaying simpler handling.';
    case 'escalate':
      return 'The case was escalated to the duty controller although it was within normal handling limits.';
    case 'notify':
      return 'Duplicate notifications were issued, causing confusion at the gate.';
  }
}

/* Composed from the case's own facts rather than picked from a bank — see the
   header of domain/outcome-notes.ts for why a five-string bank was a defect. */
function successNote(
  disruption: SyntheticCase,
  taken: ReadonlySet<ActionType>,
  missed: number,
  rating: number,
): string {
  return composeOutcomeNote(disruption.id, {
    cause: disruption.cause,
    delayMinutes: disruption.delayMinutes,
    paxCount: disruption.paxCount,
    misconnectCount: missed,
    priorityPaxCount: disruption.priorityPaxCount,
    actionsTaken: [...taken],
    outcomeRating: rating,
  });
}

function affectedCountFor(
  action: ActionType,
  disruption: SyntheticCase,
  missed: number,
  atRisk: number,
): number {
  switch (action) {
    case 'notify':
      return disruption.paxCount;
    case 'rebook':
      return Math.max(1, missed);
    case 'hotel':
      return Math.max(1, missed);
    case 'prioritise':
      return Math.max(1, missed + atRisk);
    case 'escalate':
      return 0;
  }
}

function actionDetail(action: ActionType, disruption: SyntheticCase): string {
  switch (action) {
    case 'notify':
      return 'Proactive disruption notification issued to all booked passengers.';
    case 'rebook':
      return `Misconnecting passengers reaccommodated onto later ${CARRIER_CODE} services.`;
    case 'hotel':
      return 'Overnight accommodation and transfers arranged for stranded passengers.';
    case 'prioritise':
      return 'Affected passengers triaged by connection risk and priority tier.';
    case 'escalate':
      return `Referred to the duty operations controller for a decision on the ${disruption.aircraftClass.replace('_', '-')}.`;
  }
}

// ---------------------------------------------------------------------------

/**
 * Deterministic UUID-v4-shaped identifier.
 *
 * Uses the seeded RNG rather than crypto.randomUUID() so that the entire
 * dataset -- including primary keys -- is reproducible from the seed. That
 * makes "case 4f2a… retrieved the wrong precedent" a debuggable statement
 * instead of a one-off observation.
 */
function uuid(rng: Rng): string {
  const hex: string[] = [];
  for (let i = 0; i < 32; i += 1) {
    hex.push(rng.int(0, 15).toString(16));
  }
  // Version 4, RFC 4122 variant.
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);

  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
