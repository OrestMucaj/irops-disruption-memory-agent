import {
  ACTION_PHRASE,
  AIRCRAFT_PHRASE,
  CAUSE_PHRASE,
  PRESSURE_PHRASE,
  SCALE_PHRASE,
  SEVERITY_PHRASE,
  STATION_PHRASE,
  WINDOW_CONSEQUENCE,
  WINDOW_PHRASE,
  misconnectPressureOf,
  recoveryWindowOf,
  scaleOf,
  severityOf,
  stationTypeOf,
} from './vocabulary.js';
import type { ActionType, CaseFacts, PassengerFacts } from './vocabulary.js';

/** The parts of a resolution needed to describe it. */
export interface ResolutionFacts {
  readonly actionsTaken: ReadonlyArray<{ action_type: ActionType; affected_pax: number }>;
  readonly outcomeNotes: string;
  readonly outcomeRating: number;
}

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
  disruption: CaseFacts,
  passengers: readonly PassengerFacts[],
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

  // 1. OPERATIONAL SIGNATURE. Every discriminator that should drive similarity,
  //    compressed into the opening sentence: recovery window, cause, severity,
  //    misconnect pressure, station type.
  //
  //    Order here is not cosmetic. Measured 2026-07-29: with the window buried
  //    at sentence 5 behind a boilerplate flight/route sentence, Titan scored
  //    27.8% on window match -- exactly chance -- while a lexical matcher scored
  //    70.5%. The summary had been accidentally tuned to token overlap. Leading
  //    with the window and demoting the boilerplate is the fix.
  sentences.push(
    `${capitalise(WINDOW_PHRASE[window])}. ` +
      `${capitalise(CAUSE_PHRASE[disruption.cause])} causing a ${SEVERITY_PHRASE[severity]}. ` +
      `${capitalise(PRESSURE_PHRASE[pressure])} at a ${STATION_PHRASE[originType]}.`,
  );

  // 2. Magnitude.
  sentences.push(
    `Delayed ${disruption.delayMinutes} minutes. ` +
      `${capitalise(SCALE_PHRASE[scale])} of ${disruption.paxCount} passengers, ` +
      `${disruption.misconnectCount} misconnecting, ` +
      `${missed} already missed and ${atRisk} at risk.`,
  );

  // 3. Priority pressure — a handful of premium passengers changes the handling
  //    far more than the raw count suggests.
  sentences.push(
    disruption.priorityPaxCount > 0
      ? `${disruption.priorityPaxCount} priority passengers affected.`
      : 'No priority passengers affected.',
  );

  // 4. The window's consequence, stated outright. Deliberate repetition: this
  //    is the single most decision-relevant fact about a disruption, and one
  //    mention in a subordinate clause is not enough for a semantic model to
  //    weight it properly.
  sentences.push(WINDOW_CONSEQUENCE[window]);

  if (specialHandlingCount > 0) {
    sentences.push(`${specialHandlingCount} passengers require special handling assistance.`);
  }

  // 5. Identifiers LAST, and deliberately terse. Flight number and airport pair
  //    are near-identical noise across the corpus -- they dilute the signal
  //    above without helping retrieval. They stay only because a human reading
  //    the memory view wants to know which flight this was.
  sentences.push(
    `${capitalise(AIRCRAFT_PHRASE[disruption.aircraftClass])}. ` +
      `Flight ${disruption.flightNo} ${disruption.origin} to ${disruption.destination}.`,
  );

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
  disruption: CaseFacts,
  resolution: ResolutionFacts,
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
