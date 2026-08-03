/**
 * Domain vocabulary for synthetic disruption data.
 *
 * ---------------------------------------------------------------------------
 * DATA PROVENANCE (SPEC §1.1 — non-negotiable)
 *
 * Everything here is invented or drawn from public-domain airline operations
 * concepts. Specifically:
 *
 *   - The carrier code is FICTIONAL. No real airline is modelled, named, or
 *     alluded to anywhere in this repository.
 *   - Airport codes are real IATA identifiers, which are public infrastructure
 *     references in the same category as city names. The network below is an
 *     arbitrary selection of well-known airports and deliberately does not
 *     reproduce any actual carrier's route structure.
 *   - Aircraft are described by generic size class, not manufacturer model.
 *   - Passenger references use an obviously synthetic format that cannot be
 *     mistaken for a real booking reference.
 *   - Disruption causes, connection states and handling categories are generic
 *     industry concepts of the kind described in any public overview of airline
 *     operations. No employer schema, business rule, or internal terminology is
 *     used or referenced.
 * ---------------------------------------------------------------------------
 */

// --- Column value domains (must match the CHECK constraints in 001_init.sql) --

export type Cause = 'weather' | 'technical' | 'crew' | 'atc' | 'knock_on';
export type CaseStatus = 'open' | 'planned' | 'resolved';
export type PriorityTier = 'standard' | 'priority' | 'premium';
export type ConnectionStatus = 'safe' | 'at_risk' | 'missed';
export type ActionType = 'rebook' | 'prioritise' | 'hotel' | 'notify' | 'escalate';

// --- Derived buckets: the categorical vocabulary similarity runs on ----------
//
// These exist because raw numbers make poor embedding input. "delayed 187
// minutes" and "delayed 192 minutes" are operationally identical but share
// almost no tokens; "severe delay" and "severe delay" are identical. Bucketing
// gives lexical similarity something to grip, and gives a real embedding model
// a stronger signal than digits. summary.ts emits both the bucket word and the
// number.

export type Severity = 'minor' | 'moderate' | 'severe' | 'extreme';
export type Scale = 'small' | 'medium' | 'large' | 'very_large';
export type MisconnectPressure = 'none' | 'isolated' | 'significant' | 'widespread';
export type RecoveryWindow = 'early_morning' | 'midday' | 'evening' | 'overnight';
export type AircraftClass = 'turboprop' | 'regional_jet' | 'narrow_body' | 'wide_body';
export type StationType = 'hub' | 'outstation';

/**
 * Fictional carrier code. Two letters so it reads like a flight number, chosen
 * to be visibly a placeholder rather than plausibly a real airline.
 */
export const CARRIER_CODE = 'ZZ';

/** Prefix for synthetic passenger references. Deliberately unlike a real PNR. */
export const PAX_REF_PREFIX = 'SYNPAX';

export const HUBS = ['LHR', 'FRA', 'AMS', 'CDG', 'MAD'] as const;

export const OUTSTATIONS = [
  'EDI', 'DUB', 'LIS', 'VIE', 'PRG', 'CPH', 'ARN', 'ATH', 'BCN', 'MXP',
  'ZRH', 'BRU', 'OSL', 'HEL', 'WAW', 'BUD', 'OTP', 'SOF', 'TLL', 'RIX',
] as const;

export const LONG_HAUL = ['JFK', 'BOS', 'ORD', 'YYZ', 'DXB', 'SIN', 'HKG', 'GRU', 'JNB'] as const;

export const SPECIAL_HANDLING = [
  'wheelchair',
  'unaccompanied_minor',
  'medical_equipment',
  'service_animal',
  'extra_assistance_time',
  'infant_in_arms',
] as const;

// --- Classification ---------------------------------------------------------

export function severityOf(delayMinutes: number): Severity {
  if (delayMinutes < 60) return 'minor';
  if (delayMinutes < 120) return 'moderate';
  if (delayMinutes < 240) return 'severe';
  return 'extreme';
}

export function scaleOf(paxCount: number): Scale {
  if (paxCount < 50) return 'small';
  if (paxCount < 150) return 'medium';
  if (paxCount < 250) return 'large';
  return 'very_large';
}

export function misconnectPressureOf(misconnects: number, pax: number): MisconnectPressure {
  if (misconnects === 0) return 'none';
  const share = pax > 0 ? misconnects / pax : 0;
  if (share < 0.08) return 'isolated';
  if (share < 0.2) return 'significant';
  return 'widespread';
}

/**
 * Which recovery options exist depends far more on the hour than on the length
 * of the delay. A three-hour delay at 07:00 is an inconvenience; the same delay
 * at 21:00 means hotels, and that distinction is the single most useful thing
 * the agent can learn from precedent.
 */
export function recoveryWindowOf(scheduledDep: Date): RecoveryWindow {
  const hour = scheduledDep.getUTCHours();
  if (hour >= 5 && hour < 9) return 'early_morning';
  if (hour >= 9 && hour < 16) return 'midday';
  if (hour >= 16 && hour < 21) return 'evening';
  return 'overnight';
}

export function stationTypeOf(code: string): StationType {
  return (HUBS as readonly string[]).includes(code) ? 'hub' : 'outstation';
}

/** Typical seat count by aircraft class, used to keep pax counts plausible. */
export function seatRange(aircraft: AircraftClass): readonly [number, number] {
  switch (aircraft) {
    case 'turboprop':
      return [40, 76];
    case 'regional_jet':
      return [76, 132];
    case 'narrow_body':
      return [150, 220];
    case 'wide_body':
      return [240, 340];
  }
}

// --- Human-readable phrasing ------------------------------------------------
//
// Used verbatim by summary.ts. Kept here so the vocabulary is defined in one
// place: retrieval quality depends on similar situations producing overlapping
// wording, and that only holds if the phrasing is centralised.

export const CAUSE_PHRASE: Record<Cause, string> = {
  weather: 'weather disruption',
  technical: 'aircraft technical fault',
  crew: 'crew availability shortfall',
  atc: 'air traffic control restriction',
  knock_on: 'knock-on delay from an inbound aircraft',
};

export const SEVERITY_PHRASE: Record<Severity, string> = {
  minor: 'minor delay',
  moderate: 'moderate delay',
  severe: 'severe delay',
  extreme: 'extreme delay requiring next-day recovery',
};

export const SCALE_PHRASE: Record<Scale, string> = {
  small: 'small passenger load',
  medium: 'medium passenger load',
  large: 'large passenger load',
  very_large: 'very large passenger load',
};

export const PRESSURE_PHRASE: Record<MisconnectPressure, string> = {
  none: 'no misconnections',
  isolated: 'isolated misconnections',
  significant: 'significant misconnections',
  widespread: 'widespread misconnections',
};

export const WINDOW_PHRASE: Record<RecoveryWindow, string> = {
  early_morning: 'early morning departure with same-day recovery options available',
  midday: 'midday departure with limited same-day recovery options',
  evening: 'evening departure with very few same-day recovery options',
  overnight: 'late night departure with no same-day recovery, overnight accommodation likely',
};

export const AIRCRAFT_PHRASE: Record<AircraftClass, string> = {
  turboprop: 'turboprop',
  regional_jet: 'regional jet',
  narrow_body: 'narrow-body aircraft',
  wide_body: 'wide-body aircraft',
};

export const STATION_PHRASE: Record<StationType, string> = {
  hub: 'major hub',
  outstation: 'outstation',
};

export const ACTION_PHRASE: Record<ActionType, string> = {
  rebook: 'rebooked affected passengers',
  prioritise: 'prioritised passengers by connection risk',
  hotel: 'arranged overnight accommodation',
  notify: 'issued proactive passenger notifications',
  escalate: 'escalated to the duty operations controller',
};
