import { z } from 'zod';

/**
 * Validation of model output — SPEC §5.2.
 *
 * Two separate jobs, deliberately kept apart:
 *
 *  1. **Shape** (`agentOutputSchema`) — is this even the right kind of object?
 *  2. **Grounding** (`groundActions`) — does it refer only to things that
 *     actually exist?
 *
 * The second matters more and is the one people skip. A model can emit
 * perfectly well-formed JSON citing a precedent case that was never retrieved,
 * or naming a passenger who is not on this flight. Schema validation passes
 * that straight through. For an agent whose entire pitch is "it cites its
 * precedents", an uncheckable citation is worse than no citation, because it
 * looks like evidence.
 */

export const ACTION_TYPES = ['rebook', 'prioritise', 'hotel', 'notify', 'escalate'] as const;

/** Cap on actions per case. A 400-action plan is a malfunction, not a plan. */
export const MAX_ACTIONS = 25;

export const proposedActionSchema = z.object({
  action_type: z.enum(ACTION_TYPES),
  /** null for case-level actions that are not about one passenger. */
  target_pax_ref: z.string().min(1).max(64).nullable().catch(null).default(null),
  rationale: z.string().min(1).max(1500),
  precedent_case_ids: z.array(z.string().min(1).max(64)).max(10).catch([]).default([]),
  confidence: z.number().min(0).max(1),
  payload: z.record(z.unknown()).catch({}).default({}),
});

export const agentOutputSchema = z.object({
  actions: z.array(proposedActionSchema).max(MAX_ACTIONS),
});

export type ProposedActionInput = z.infer<typeof proposedActionSchema>;

export interface GroundingContext {
  /** Case IDs actually returned by retrieval this run. */
  readonly retrievedCaseIds: ReadonlySet<string>;
  /** Passenger references actually attached to this case. */
  readonly knownPaxRefs: ReadonlySet<string>;
}

export interface GroundedAction extends ProposedActionInput {
  readonly precedent_case_ids: string[];
}

export interface GroundingResult {
  readonly actions: GroundedAction[];
  /** Human-readable notes about what was stripped and why. */
  readonly warnings: string[];
  readonly droppedActions: number;
  readonly droppedCitations: number;
}

/**
 * Strips anything the model invented.
 *
 * The two failure modes are treated asymmetrically on purpose:
 *
 *  - **A fabricated precedent citation** is removed, but the action survives.
 *    The recommendation may still be sound; it just is not supported by the
 *    case it claims. Losing the citation is the honest outcome.
 *
 *  - **A fabricated passenger reference** kills the whole action. This one
 *    could result in a real person being rebooked, hotelled, or deprioritised
 *    on the strength of a name the model made up. There is no safe way to
 *    partially honour that, so it goes.
 */
export function groundActions(
  actions: readonly ProposedActionInput[],
  context: GroundingContext,
): GroundingResult {
  const kept: GroundedAction[] = [];
  const warnings: string[] = [];
  let droppedActions = 0;
  let droppedCitations = 0;

  for (const [index, action] of actions.entries()) {
    if (action.target_pax_ref !== null && !context.knownPaxRefs.has(action.target_pax_ref)) {
      droppedActions += 1;
      warnings.push(
        `action ${index} (${action.action_type}) dropped: target_pax_ref ` +
          `"${action.target_pax_ref}" is not a passenger on this case`,
      );
      continue;
    }

    const validCitations = action.precedent_case_ids.filter((id) =>
      context.retrievedCaseIds.has(id),
    );
    const invalidCount = action.precedent_case_ids.length - validCitations.length;
    if (invalidCount > 0) {
      droppedCitations += invalidCount;
      warnings.push(
        `action ${index} (${action.action_type}): removed ${invalidCount} citation(s) ` +
          'to cases that were not retrieved for this run',
      );
    }

    kept.push({ ...action, precedent_case_ids: validCitations });
  }

  return { actions: kept, warnings, droppedActions, droppedCitations };
}

/**
 * Pulls a JSON object out of a model response.
 *
 * The prompt demands bare JSON and SPEC §5.2 says to parse defensively, which
 * are not in tension: instruct strictly, accept the common deviations anyway.
 * Markdown fences and a line of preamble are what models actually do, and
 * failing the run over a ```json wrapper would be a self-inflicted outage.
 *
 * Returns null rather than throwing so the caller can decide whether to retry.
 */
export function extractJson(text: string): unknown {
  const attempts: string[] = [];

  const trimmed = text.trim();
  attempts.push(trimmed);

  // ```json ... ``` or ``` ... ```
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1] !== undefined) attempts.push(fenced[1].trim());

  // First balanced-looking object.
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    attempts.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next shape.
    }
  }

  return null;
}
