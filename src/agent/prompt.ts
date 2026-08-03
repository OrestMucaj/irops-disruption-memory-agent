import { misconnectPressureOf, recoveryWindowOf, severityOf } from '../domain/vocabulary.js';

import { ACTION_TYPES, MAX_ACTIONS } from './schema.js';
import type { CaseRecord, PassengerRecord, Precedent } from './retrieval.js';

/**
 * Prompt construction — SPEC §5.2.
 *
 * The prompt's job is not to be clever. It is to present precedent honestly and
 * make the output easy to validate. Two decisions worth keeping:
 *
 *  1. **Badly-rated precedents are included, and labelled as warnings.** The
 *     obvious move is to show the model only successful cases. That throws away
 *     the most informative rows in the dataset — 14 of the 80 seeded
 *     resolutions went wrong, and *why* they went wrong is exactly the
 *     institutional knowledge this system exists to retain.
 *
 *  2. **The model is told it may only cite what it was given.** It is then
 *     checked anyway (schema.ts `groundActions`). Instructions reduce
 *     hallucination; they do not prevent it, and an unverifiable citation is
 *     worse than none.
 */

/** How many passengers to include before truncating. */
const MAX_PASSENGERS_IN_PROMPT = 20;

export const SYSTEM_PROMPT = `You are an operations-support assistant for an airline irregular operations (IROPS) desk.

You are given one active disruption and a set of retrieved precedents: past disruptions that were resolved, what was done, and how well it worked. Your job is to propose a concrete action plan for the active case.

RULES

1. Output STRICT JSON ONLY. No prose, no markdown, no code fences, before or after. The entire response must parse as one JSON object.

2. The shape is exactly:
{
  "actions": [
    {
      "action_type": "rebook" | "prioritise" | "hotel" | "notify" | "escalate",
      "target_pax_ref": string | null,
      "rationale": string,
      "precedent_case_ids": string[],
      "confidence": number
    }
  ]
}

3. "target_pax_ref" must be either null (for actions that apply to the whole case) or EXACTLY one of the passenger references listed in the active case. Never invent a passenger reference.

4. "precedent_case_ids" must contain only case IDs from the PRECEDENTS section. Cite the precedents that actually informed the action. An empty array is acceptable and is better than a citation you cannot justify. Never invent a case ID.

5. "confidence" is a number from 0 to 1 reflecting how strongly the precedent supports the action. Lower it when precedents are few, distant, or conflicting.

6. "rationale" is one or two sentences explaining why, referring to the precedent where relevant. Be specific and operational.

7. Propose at most ${MAX_ACTIONS} actions.

8. COVERAGE. Every passenger whose connection is already MISSED must be addressed by at least one action that actually reaccommodates them — a rebooking, accommodation, or explicit prioritisation. A missed connection is not a judgement call: that passenger is stranded and needs handling regardless of whether they have special requirements. Notifying them is not sufficient.

   Passengers whose connection is AT RISK are different, and here judgement applies: their connection may still hold, and rebooking everyone releases seats that may not need releasing. Triage by how tight the buffer is and by priority tier. A single case-level "prioritise" covering the group is often better than many individual actions.

   Do not select passengers on the basis of special-handling requirements alone. Special handling changes *how* someone is looked after, not *whether* they need reaccommodating.

9. Precedents with a LOW outcome rating are warnings, not templates. If a past case went badly because something was not done, that is strong evidence for doing it here. Say so in the rationale.

10. You recommend only. Nothing you output is executed automatically; a human reviews and approves every action. Do not describe actions as already taken.`;

export function buildUserMessage(
  subject: CaseRecord,
  passengers: readonly PassengerRecord[],
  precedents: readonly Precedent[],
): string {
  const sections: string[] = [];

  // --- Active case ---------------------------------------------------------
  const severity = severityOf(subject.delayMinutes);
  const window = recoveryWindowOf(subject.scheduledDep);
  const pressure = misconnectPressureOf(subject.misconnectCount, subject.paxCount);

  sections.push(
    [
      'ACTIVE CASE',
      `case_id: ${subject.id}`,
      `flight: ${subject.flightNo} ${subject.origin} -> ${subject.destination}`,
      `scheduled departure: ${subject.scheduledDep.toISOString()}`,
      `delay: ${subject.delayMinutes} minutes (${severity})`,
      `cause: ${subject.cause}`,
      `aircraft: ${subject.aircraftClass}`,
      `passengers on board: ${subject.paxCount}`,
      `misconnecting: ${subject.misconnectCount} (${pressure})`,
      `priority passengers: ${subject.priorityPaxCount}`,
      `recovery window: ${window}`,
      `status: ${subject.status}`,
    ].join('\n'),
  );

  // --- Passengers ----------------------------------------------------------
  const shown = passengers.slice(0, MAX_PASSENGERS_IN_PROMPT);
  const paxLines = shown.map((p) => {
    const parts = [
      `- ${p.paxRef}`,
      `tier=${p.priorityTier}`,
      `connection=${p.connectionStatus}`,
    ];
    if (p.connectionMinutes !== null) parts.push(`buffer=${p.connectionMinutes}min`);
    if (p.onwardFlight !== null) parts.push(`onward=${p.onwardFlight}`);
    if (p.rebookedTo !== null) parts.push(`already_rebooked=${p.rebookedTo}`);
    if (p.specialHandling.length > 0) parts.push(`special=${p.specialHandling.join('/')}`);
    return parts.join(' ');
  });

  if (passengers.length > shown.length) {
    paxLines.push(`- (${passengers.length - shown.length} further passengers not shown)`);
  }

  sections.push(
    ['AFFECTED PASSENGERS', ...(paxLines.length > 0 ? paxLines : ['(none recorded)'])].join('\n'),
  );

  // --- Precedents ----------------------------------------------------------
  if (precedents.length === 0) {
    sections.push(
      'PRECEDENTS\n(none found — propose only what the case facts justify, and use low confidence)',
    );
  } else {
    const blocks = precedents.map((p, i) => {
      const lines = [
        `[${i + 1}] case_id: ${p.caseId}`,
        `similarity_distance: ${p.distance.toFixed(4)} (lower is more similar)`,
        `summary: ${p.summaryText}`,
      ];

      if (p.outcome === null) {
        lines.push('outcome: not recorded');
      } else {
        const actions = p.outcome.actionsTaken
          .map((a) => `${a.action_type} (${a.affected_pax} pax)`)
          .join(', ');
        lines.push(`actions_taken: ${actions.length > 0 ? actions : 'none'}`);
        lines.push(
          `outcome_rating: ${p.outcome.outcomeRating ?? 'unrated'} out of 5` +
            (p.outcome.outcomeRating !== null && p.outcome.outcomeRating <= 2
              ? '   <-- THIS WENT BADLY. Treat as a warning.'
              : ''),
        );
        if (p.outcome.outcomeNotes !== null) {
          lines.push(`outcome_notes: ${p.outcome.outcomeNotes}`);
        }
      }

      return lines.join('\n');
    });

    sections.push(['PRECEDENTS', ...blocks].join('\n\n'));
  }

  sections.push('Respond with the JSON object only.');

  return sections.join('\n\n');
}
