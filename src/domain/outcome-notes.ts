/**
 * Composes the free-text outcome note a desk writes when it closes a case.
 *
 * This is the single most-read string in the product. It is what a reviewer
 * sees when they open a retrieved precedent and ask "what actually happened
 * last time" — the moment the whole memory premise either lands or does not.
 *
 * The first version of this drew from a fixed bank of five sentences, which
 * produced 81 resolutions carrying 13 distinct strings, three of them repeated
 * fifteen times each. Two precedents opened side by side read identically, and
 * near-duplicate text is near-duplicate embedding, so the resolution vectors
 * carried almost no signal to retrieve on either.
 *
 * So the note is composed from the case's own facts — how late, how many
 * misconnected, what the desk actually did — rather than picked from a list.
 * The numbers vary per case, which makes collisions unlikely without needing a
 * larger bank of prose. The voice deliberately matches the failure notes in
 * seed/generate.ts, which were already specific and are left alone.
 */

/** The five boilerplate strings the old bank produced. Matched exactly, so a
 *  backfill can replace them without touching a note somebody meant. */
export const LEGACY_SUCCESS_NOTES: readonly string[] = [
  'Handled to plan; affected passengers were reaccommodated without escalation.',
  'Early action held the majority of connections and complaint volume was low.',
  'Standard playbook applied and the recovery ran without incident.',
  'Accommodation was arranged before the transfer desk backed up, which kept the operation orderly.',
  'Triage by connection risk meant the tightest connections were worked first and most were saved.',
];

export interface OutcomeNoteFacts {
  readonly cause: string;
  readonly delayMinutes: number;
  readonly paxCount: number;
  readonly misconnectCount: number;
  readonly priorityPaxCount: number;
  readonly actionsTaken: readonly string[];
  readonly outcomeRating: number;
}

/** Deterministic from a string seed, so a case always produces the same note. */
function seededPick<T>(seed: string, salt: number, options: readonly T[]): T {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return options[Math.abs(h) % options.length] as T;
}

/** What the desk did, carrying the counts that make it a specific case. */
function actionClause(seed: string, f: OutcomeNoteFacts): string {
  const took = new Set(f.actionsTaken);
  const missed = Math.max(1, f.misconnectCount);

  if (took.has('rebook') && took.has('hotel')) {
    return seededPick(seed, 1, [
      `Rebooked what could be rebooked and put the remaining ${missed} passengers up overnight`,
      `Split the ${missed} misconnections between the next morning's wave and overnight accommodation`,
      `Reaccommodated onto later services where seats existed and hotelled the rest of the ${missed}`,
    ]);
  }
  if (took.has('rebook')) {
    return seededPick(seed, 2, [
      `Rebooked the ${missed} misconnecting passengers onto later services`,
      `Pushed all ${missed} misconnections onto the next available wave`,
      `Reaccommodated ${missed} passengers before they reached the transfer desk`,
    ]);
  }
  if (took.has('hotel')) {
    return seededPick(seed, 3, [
      `Placed ${missed} passengers overnight with transfers arranged`,
      `Booked accommodation for the ${missed} stranded passengers`,
    ]);
  }
  if (took.has('prioritise')) {
    return seededPick(seed, 4, [
      `Triaged by connection buffer and worked the tightest pairs first`,
      `Sorted the queue by remaining buffer rather than arrival order`,
    ]);
  }
  if (took.has('escalate')) {
    return `Escalated to the duty controller early`;
  }
  return seededPick(seed, 5, [
    `Notified all ${f.paxCount} booked passengers ahead of the delay`,
    `Held to a notification-only response`,
  ]);
}

/** Why the delay happened, in the language the cause actually gets discussed in. */
function causeClause(seed: string, f: OutcomeNoteFacts): string {
  const d = f.delayMinutes;
  switch (f.cause) {
    case 'weather':
      return seededPick(seed, 6, [
        `the ${d}-minute weather hold`,
        `a ${d}-minute wait for the front to clear`,
        `${d} minutes lost to de-icing and slot loss`,
      ]);
    case 'technical':
      return seededPick(seed, 7, [
        `a ${d}-minute technical delay`,
        `${d} minutes on stand waiting for engineering`,
        `the ${d}-minute defect rectification`,
      ]);
    case 'crew':
      return seededPick(seed, 8, [
        `${d} minutes lost sourcing a legal crew`,
        `a ${d}-minute crew rotation gap`,
      ]);
    case 'atc':
      return seededPick(seed, 9, [
        `a ${d}-minute ATC flow restriction`,
        `${d} minutes of slot delay`,
      ]);
    default:
      return seededPick(seed, 10, [
        `an inbound aircraft ${d} minutes late`,
        `the ${d}-minute knock-on from the previous rotation`,
      ]);
  }
}

/** How it landed. The rating is the ground truth; this says it in words. */
function resultClause(seed: string, f: OutcomeNoteFacts): string {
  const priority = f.priorityPaxCount;
  if (f.outcomeRating >= 5) {
    return seededPick(seed, 11, [
      'Nothing was left on the ground and no complaints were logged.',
      `Every connection held, including all ${priority} priority passengers.`,
      'The recovery closed out clean.',
    ]);
  }
  if (f.outcomeRating === 4) {
    return seededPick(seed, 12, [
      'Most connections held and the desk stayed ahead of the queue.',
      `The ${priority} priority passengers were all protected.`,
      'A handful went out the following morning, but nobody queued long.',
    ]);
  }
  return seededPick(seed, 13, [
    'It worked, but the desk was reacting rather than ahead of it.',
    'Recovery held, though later than it should have.',
    'Acceptable outcome; the queue built before it cleared.',
  ]);
}

export function composeOutcomeNote(seed: string, f: OutcomeNoteFacts): string {
  return `${actionClause(seed, f)} after ${causeClause(seed, f)}. ${resultClause(seed, f)}`;
}
