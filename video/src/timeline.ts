import voiceover from './data/voiceover.json';

/**
 * The whole video is timed from the narration.
 *
 * Each section's audio is placed after the previous one plus a gap; every
 * scene, cue and caption is derived from those positions and from the word
 * timings ElevenLabs returned. Re-generating a section re-times everything
 * downstream of it, so picture and voice cannot drift apart.
 */

export const FPS = 30;

export type Word = { text: string; start: number; end: number };

type RawSection = (typeof voiceover)[number];

export type Section = RawSection & {
  /** Absolute start of the section's audio, in seconds. */
  at: number;
  /** Words with absolute times, in seconds. */
  abs: Word[];
};

export type SceneId = 'hook' | 'intro' | 'demo' | 'loop' | 'analyst' | 'engineering' | 'close';

/** Silence after each section. Longer where the picture needs to land. */
const GAP_AFTER: Record<string, number> = {
  's01-hook': 0.6,
  's02-problem': 0.35,
  's03-reveal': 0.8,
  's04-console': 0.55,
  's05-plan': 0.45,
  's06-guardrail': 0.3,
  's07-precedent': 0.4,
  's08-approve': 0.85,
  's09-audit': 0.7,
  's10-loop': 0.3,
  's11-close': 0.5,
  's12-chatbot': 0.7,
  's13-analyst': 0.7,
  's14-db': 0.3,
  's15-index': 0.4,
  's16-aws': 0.8,
  's17-close': 0,
};

const LEAD_IN = 0.25;
const END_HOLD = 4.6;

export const sections: Section[] = (() => {
  let t = LEAD_IN;
  return voiceover.map((s) => {
    const section: Section = {
      ...s,
      at: t,
      abs: s.words.map((w) => ({ text: w.text, start: t + w.start, end: t + w.end })),
    };
    t += s.audioDuration + (GAP_AFTER[s.id] ?? 0.4);
    return section;
  });
})();

const last = sections[sections.length - 1];
export const TOTAL_SECONDS = last.at + last.audioDuration + END_HOLD;
export const TOTAL_FRAMES = Math.ceil(TOTAL_SECONDS * FPS);

export const f = (seconds: number) => Math.round(seconds * FPS);

export const section = (id: string): Section => {
  const s = sections.find((x) => x.id === id);
  if (!s) throw new Error(`unknown section ${id}`);
  return s;
};

const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9'-]/g, '');

/**
 * Absolute time (seconds) of a word in a section: by index, or by the first
 * word matching `text` (punctuation-insensitive), optionally the nth match.
 */
export function wordTime(id: string, word: number | string, edge: 'start' | 'end' = 'start', nth = 0): number {
  const s = section(id);
  let w: Word | undefined;
  if (typeof word === 'number') {
    w = s.abs[word];
  } else {
    const matches = s.abs.filter((x) => norm(x.text) === norm(word));
    w = matches[nth];
  }
  if (!w) throw new Error(`no word "${word}" in ${id}`);
  return w[edge];
}

export const sectionEnd = (id: string) => {
  const s = section(id);
  return s.at + s.audioDuration;
};

/** Scene spans: each scene starts midway through the gap before its first section. */
const SCENE_ORDER: SceneId[] = ['hook', 'intro', 'demo', 'loop', 'analyst', 'engineering', 'close'];

export const CROSSFADE = 16;

export const scenes: Record<SceneId, { from: number; duration: number }> = (() => {
  const starts = SCENE_ORDER.map((id, i) => {
    if (i === 0) return 0;
    const first = sections.find((s) => s.scene === id)!;
    const prevIdx = sections.indexOf(first) - 1;
    const prevEnd = sections[prevIdx].at + sections[prevIdx].audioDuration;
    return f((prevEnd + first.at) / 2) - CROSSFADE / 2;
  });
  const out = {} as Record<SceneId, { from: number; duration: number }>;
  SCENE_ORDER.forEach((id, i) => {
    const from = starts[i];
    const to = i === SCENE_ORDER.length - 1 ? TOTAL_FRAMES : starts[i + 1] + CROSSFADE;
    out[id] = { from, duration: to - from };
  });
  return out;
})();

/** Frame of a word relative to a scene's start. */
export const cue = (scene: SceneId, id: string, word: number | string, edge: 'start' | 'end' = 'start', nth = 0) =>
  f(wordTime(id, word, edge, nth)) - scenes[scene].from;

/** Frame of a section boundary relative to a scene's start. */
export const cueSection = (scene: SceneId, id: string, edge: 'start' | 'end' = 'start') =>
  f(edge === 'start' ? section(id).at : sectionEnd(id)) - scenes[scene].from;
