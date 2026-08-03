import {
  ACTION_PHRASE,
  AIRCRAFT_PHRASE,
  CAUSE_PHRASE,
  PRESSURE_PHRASE,
  SCALE_PHRASE,
  SEVERITY_PHRASE,
  STATION_PHRASE,
  WINDOW_PHRASE,
  misconnectPressureOf,
  recoveryWindowOf,
  scaleOf,
  severityOf,
  stationTypeOf,
} from './domain.js';
import type { SyntheticCase, SyntheticPassenger, SyntheticResolution } from './types.js';

/**
 * Builds the natural-language digest that semantic similarity actually runs on.
 *
 * SPEC §4 calls this out as high-leverage, and it is: the vector index never
 * sees `delay_minutes` or `cause`. It sees only this string. Retrieval quality
 * is a property of this function, not of the database.
 *
 * Three rules it follows, each learned the hard way in RAG systems generally:
 *
 *  1. **Lead with what makes cases operationally alike.** Cause, severity,
 *     station type and recovery window decide what you *do*. Flight number and
 *     airport pair barely matter for choosing a response, so they come later
 *     and stay brief — otherwise every LHR flight looks similar to every other
 *     LHR flight regardless of what actually went wrong.
 *
 *  2. **Emit the bucket word AND the number.** "severe delay" gives lexical and
 *     semantic similarity something stable to match on; "187 minutes" preserves
 *     the detail a reader (and a reasoning model) needs. Numbers alone are
 *     nearly useless to an embedding: 187 and 192 are operationally identical
 *     and lexically unrelated.
 *
 *  3. **Deterministic.** Same case, same string, always. No randomness, no
 *     timestamps, no ordering that depends on a Map's iteration order. A
 *     summary that drifts silently invalidates every stored embedding.
 *
 * Keep this function and the retrieval-time summary builder identical — if a
 * new case is summarised differently from the seeded ones, similarity collapses
 * and the failure is silent.
 */
export function buildCaseSummary(
  disruption: SyntheticCase,
  passengers: readonly SyntheticPassenger[],
): string {
  const severity = severityOf(disruption.delayMinutes);
  const scale = scaleOf(disruption.paxCount);
  const pressure = misconnectPressureOf(disruption.misconnectCount, disruption.paxCount);
  const window = recoveryWindowOf(disruption.scheduledDep);
  const originType = stationTypeOf(disruption.origin);

  const specialHandlingCount = passengers.filter((p) => p.specialHandling.length > 0).length;
  const missed = passengers.filter((p) => p.connectionStatus === 'missed').length;
  const atRisk = passengers.filter((p) => p.connectionStatus === 'at_risk').length;

  const sentences: string[] = [];

  // 1. The operational shape. This is the part that should dominate similarity.
  sentences.push(
    `${capitalise(CAUSE_PHRASE[disruption.cause])} causing a ` +
      `${SEVERITY_PHRASE[severity]} at a ${STATION_PHRASE[originType]}.`,
  );

  // 2. Concrete specifics, kept deliberately short.
  sentences.push(
    `Flight ${disruption.flightNo} from ${disruption.origin} to ${disruption.destination}, ` +
      `${AIRCRAFT_PHRASE[disruption.aircraftClass]}, delayed ${disruption.delayMinutes} minutes.`,
  );

  // 3. Who is affected and how badly.
  sentences.push(
    `${capitalise(SCALE_PHRASE[scale])} of ${disruption.paxCount} passengers with ` +
      `${PRESSURE_PHRASE[pressure]}: ${disruption.misconnectCount} passengers misconnecting, ` +
      `${missed} already missed and ${atRisk} at risk.`,
  );

  // 4. Priority pressure — a small number of premium passengers changes the
  //    handling far more than the raw count suggests.
  if (disruption.priorityPaxCount > 0) {
    sentences.push(
      `${disruption.priorityPaxCount} priority passengers affected.`,
    );
  } else {
    sentences.push('No priority passengers affected.');
  }

  // 5. The recovery window. Frequently the deciding factor.
  sentences.push(`${capitalise(WINDOW_PHRASE[window])}.`);

  // 6. Special handling, only when present.
  if (specialHandlingCount > 0) {
    sentences.push(
      `${specialHandlingCount} passengers require special handling assistance.`,
    );
  }

  return sentences.join(' ');
}

/**
 * Digest of what was actually done and how it turned out.
 *
 * Deliberately leads with the *outcome*, not the actions. SPEC §5.1 is blunt
 * that precedent without outcome is useless, and this text is what the memory
 * view surfaces — "this worked" and "this backfired" are the useful retrieval
 * targets, not "someone pressed rebook".
 */
export function buildResolutionSummary(
  disruption: SyntheticCase,
  resolution: SyntheticResolution,
): string {
  const severity = severityOf(disruption.delayMinutes);
  const window = recoveryWindowOf(disruption.scheduledDep);
  const verdict = outcomeVerdict(resolution.outcomeRating);

  const actions = resolution.actionsTaken.length > 0
    ? resolution.actionsTaken
        .map((a) => `${ACTION_PHRASE[a.action_type]} (${a.affected_pax} passengers)`)
        .join(', ')
    : 'no operational action taken beyond monitoring';

  return [
    `${capitalise(verdict)} resolution of a ${CAUSE_PHRASE[disruption.cause]} causing a ` +
      `${SEVERITY_PHRASE[severity]}.`,
    `${capitalise(WINDOW_PHRASE[window])}.`,
    `Actions taken: ${actions}.`,
    `Outcome rated ${resolution.outcomeRating} out of 5. ${resolution.outcomeNotes}`,
  ].join(' ');
}

function outcomeVerdict(rating: number): string {
  if (rating >= 5) return 'highly effective';
  if (rating === 4) return 'effective';
  if (rating === 3) return 'acceptable';
  if (rating === 2) return 'poor';
  return 'failed';
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}
