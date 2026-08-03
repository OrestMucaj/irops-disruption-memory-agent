import type {
  LLMCompletionRequest,
  LLMCompletionResult,
  LLMProvider,
} from '../types.js';

/**
 * Rule-based stand-in for the reasoning model.
 *
 * ===========================================================================
 * THIS IS NOT AN LLM. It does no reasoning. It is a hand-written decision tree
 * that reads the prompt, applies a fixed playbook, and emits the JSON an actual
 * model would be asked for.
 *
 * It exists for exactly two reasons:
 *
 *   1. The whole loop -- retrieval, validation, grounding, persistence,
 *      agent_runs logging, and eventually the UI -- can be built and exercised
 *      end to end with no AWS account and no per-call cost.
 *   2. It is a baseline. If Bedrock cannot beat a decision tree at this task,
 *      that is worth knowing early.
 *
 * It must NEVER be used for the demo or described as the agent's reasoning.
 * LLM_PROVIDER=bedrock is the real path; this is scaffolding.
 * ===========================================================================
 */
export class HeuristicLLMProvider implements LLMProvider {
  public readonly name = 'heuristic';
  public readonly modelId = 'heuristic-playbook-v1';

  public complete(request: LLMCompletionRequest): Promise<LLMCompletionResult> {
    const facts = readPrompt(request.user);
    const actions = decide(facts);
    const text = JSON.stringify({ actions });

    return Promise.resolve({
      text,
      // Synthetic. Recorded so the agent_runs path is exercised, but these are
      // not tokenizer output and must not be read as cost data.
      promptTokens: Math.ceil((request.system.length + request.user.length) / 4),
      completionTokens: Math.ceil(text.length / 4),
    });
  }
}

interface PromptFacts {
  severity: string;
  recoveryWindow: string;
  cause: string;
  misconnecting: number;
  priorityPax: number;
  passengers: Array<{ ref: string; status: string; tier: string }>;
  precedents: Array<{ caseId: string; rating: number | null }>;
}

/**
 * Reads the structured facts back out of the prompt.
 *
 * Coupled to prompt.ts's formatting, which is ugly but contained: this provider
 * is scaffolding, and the coupling is the price of not having to thread a
 * parallel structured channel through the LLMProvider interface purely for a
 * fake. If the prompt format changes, this degrades to proposing less, not to
 * proposing something wrong.
 */
function readPrompt(text: string): PromptFacts {
  const grab = (re: RegExp, fallback = ''): string => re.exec(text)?.[1]?.trim() ?? fallback;

  const passengers: PromptFacts['passengers'] = [];
  const paxRe = /^- (\S+) tier=(\S+) connection=(\S+)/gm;
  for (let m = paxRe.exec(text); m !== null; m = paxRe.exec(text)) {
    const [, ref, tier, status] = m;
    if (ref !== undefined && tier !== undefined && status !== undefined) {
      passengers.push({ ref, tier, status });
    }
  }

  const precedents: PromptFacts['precedents'] = [];
  const blockRe = /case_id: (\S+)([\s\S]*?)(?=\n\[\d+\] case_id:|$)/g;
  for (let m = blockRe.exec(text); m !== null; m = blockRe.exec(text)) {
    const caseId = m[1];
    const body = m[2] ?? '';
    if (caseId === undefined) continue;
    // Skip the ACTIVE CASE block, which also contains "case_id:".
    if (!/similarity_distance/.test(body)) continue;
    const rating = /outcome_rating: (\d+)/.exec(body)?.[1];
    precedents.push({ caseId, rating: rating === undefined ? null : Number(rating) });
  }

  return {
    severity: grab(/delay: \d+ minutes \(([a-z]+)\)/),
    recoveryWindow: grab(/recovery window: (\S+)/),
    cause: grab(/cause: (\S+)/),
    misconnecting: Number(grab(/misconnecting: (\d+)/, '0')),
    priorityPax: Number(grab(/priority passengers: (\d+)/, '0')),
    passengers,
    precedents,
  };
}

function decide(facts: PromptFacts): unknown[] {
  const actions: unknown[] = [];

  // Cite the closest precedent, and any that went badly -- a low-rated
  // precedent is the strongest argument for doing the thing that was skipped.
  const nearest = facts.precedents[0]?.caseId;
  const cautionary = facts.precedents.filter((p) => p.rating !== null && p.rating <= 2);
  const cite = (extra: string[] = []): string[] =>
    [...new Set([...(nearest === undefined ? [] : [nearest]), ...extra])];

  const missed = facts.passengers.filter((p) => p.status === 'missed');
  const atRisk = facts.passengers.filter((p) => p.status === 'at_risk');
  const severe = facts.severity === 'severe' || facts.severity === 'extreme';
  const lateInDay = facts.recoveryWindow === 'evening' || facts.recoveryWindow === 'overnight';

  actions.push({
    action_type: 'notify',
    target_pax_ref: null,
    rationale: `Proactive notification for a ${facts.severity} ${facts.cause} delay affecting ${facts.misconnecting} connecting passengers.`,
    precedent_case_ids: cite(),
    confidence: 0.9,
  });

  for (const p of missed.slice(0, 8)) {
    actions.push({
      action_type: 'rebook',
      target_pax_ref: p.ref,
      rationale: 'Connection already missed; reaccommodation is required regardless of recovery time.',
      precedent_case_ids: cite(),
      confidence: 0.85,
    });
  }

  if (lateInDay && severe && facts.misconnecting > 0) {
    actions.push({
      action_type: 'hotel',
      target_pax_ref: null,
      rationale:
        `A ${facts.severity} delay with a ${facts.recoveryWindow} departure leaves no same-day recovery. ` +
        (cautionary.length > 0
          ? 'A closely comparable past case scored poorly precisely because accommodation was not arranged in time.'
          : 'Arrange accommodation before the transfer desk backs up.'),
      precedent_case_ids: cite(cautionary.map((c) => c.caseId).slice(0, 3)),
      confidence: cautionary.length > 0 ? 0.88 : 0.7,
    });
  }

  if (atRisk.length > 0 && facts.priorityPax > 0) {
    actions.push({
      action_type: 'prioritise',
      target_pax_ref: null,
      rationale: `${atRisk.length} connections still recoverable and ${facts.priorityPax} priority passengers affected; work the tightest buffers first.`,
      precedent_case_ids: cite(),
      confidence: 0.65,
    });
  }

  if (facts.cause === 'technical' && severe) {
    actions.push({
      action_type: 'escalate',
      target_pax_ref: null,
      rationale: 'Technical fault with a severe delay; a duty controller decision on the aircraft is needed before further reaccommodation.',
      precedent_case_ids: cite(),
      confidence: 0.6,
    });
  }

  return actions;
}
