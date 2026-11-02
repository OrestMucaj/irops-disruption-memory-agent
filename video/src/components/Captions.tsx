import React, { useMemo } from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';

import { FPS, sectionEnd, sections, Word, wordTime } from '../timeline';
import { C, FONT } from '../theme';

/**
 * Burned-in captions for muted viewing, built from the narration's own word
 * timings. Pages break at sentence and clause punctuation or at ~44
 * characters, and never leave a sentence's last word on a page of its own;
 * long sentences are broken by hand (PAGES). The spoken word is full white;
 * the rest of the page is dimmer.
 *
 * Where a scene already sets the narration as on-screen type (the hook's
 * question, the product reveal, the closing line), captions stand down so the
 * same words never appear twice.
 */

/** Section words that are set as on-screen type instead of captioned. */
const SUPPRESS: Record<string, (w: Word, i: number, all: Word[]) => boolean> = {
  's01-hook': (_w, i, all) => i >= all.findIndex((x) => x.text === 'What'),
  's03-reveal': () => true,
  's17-close': () => true,
};

/**
 * Spans (seconds) where captions sit higher, clear of UI that the walkthrough
 * needs at the bottom of the frame — the console's sticky decision bar.
 */
const LIFTED: [number, number][] = [[wordTime('s08-approve', 0) - 0.3, sectionEnd('s08-approve') + 0.55]];

/** Hand-set pages where the automatic breaks would split a phrase. */
const PAGES: Record<string, string[]> = {
  's05-plan': ['One click:', 'the agent embeds the case,', 'finds similar past disruptions,', 'and Nova Lite proposes a plan', 'that cites its precedents.'],
  's06-guardrail': ['Code checks the plan too:', 'stranded passengers left uncovered', 'are flagged before anyone approves.'],
  's07-precedent': ['Open a precedent to see', 'what the desk did last time,', 'and how it turned out.', 'Mixed results come back too,', 'with what went wrong.'],
  's11-close': [
    "Record the outcome, and it's written",
    'with its embedding in the same transaction',
    'that turns the case into precedent.',
    'Search for a similar weather disruption now,',
    'and ZZ1137 comes back.',
  ],
  's12-chatbot': ['Even rejected proposals are kept.', 'Unlike a chatbot, what it recommends tomorrow', 'depends on what it recorded today.'],
  's13-analyst': [
    'You can also question the memory in plain English.',
    'Nova Lite writes the SQL and runs it',
    "through CockroachDB's managed MCP server,",
    "read-only by the app's own guardrails.",
  ],
  's13b-answer': ['The answer arrives with the query', 'and the rows behind it:', 'weather, at 3.45.'],
  's14-db': ['Under the hood, records and embeddings', 'live in one CockroachDB database', 'and commit in the same transaction:', 'no sync job, no drift.'],
  's16-aws': [
    'On AWS, Bedrock provides Titan embeddings',
    'and Nova Lite reasoning,',
    'Lambda runs the agent,',
    'and S3 serves the console,',
    'scaling to zero when idle.',
  ],
};

type Page = { words: Word[]; start: number; end: number };

function buildPages(): Page[] {
  const pages: Page[] = [];
  for (const s of sections) {
    const fixed = PAGES[s.id];
    if (fixed) {
      let i = 0;
      for (const text of fixed) {
        const words = s.abs.slice(i, i + text.split(' ').length);
        if (words.map((w) => w.text).join(' ') !== text) throw new Error(`caption page "${text}" doesn't match ${s.id}`);
        pages.push({ words, start: words[0].start, end: words[words.length - 1].end });
        i += words.length;
      }
      if (i !== s.abs.length) throw new Error(`caption pages for ${s.id} leave words out`);
      continue;
    }
    const skip = SUPPRESS[s.id];
    let current: Word[] = [];
    const flush = () => {
      if (current.length) pages.push({ words: current, start: current[0].start, end: current[current.length - 1].end });
      current = [];
    };
    s.abs.forEach((w, i) => {
      if (skip && skip(w, i, s.abs)) {
        flush();
        return;
      }
      const len = current.map((x) => x.text).join(' ').length + w.text.length + 1;
      if (current.length && len > 44 && !(/[.:?!;]$/.test(w.text) && len <= 54)) flush();
      current.push(w);
      if (/[.:?!;]$/.test(w.text) || (/,$/.test(w.text) && current.map((x) => x.text).join(' ').length > 22)) flush();
    });
    flush();
  }
  // Hold each page until the next begins (bounded), so short pauses don't flicker.
  return pages.map((p, i) => {
    const next = pages[i + 1];
    const hold = next ? Math.min(next.start, p.end + 0.6) : p.end + 0.6;
    return { ...p, end: Math.max(p.end + 0.15, hold) };
  });
}

export const Captions: React.FC = () => {
  const frame = useCurrentFrame();
  const pages = useMemo(buildPages, []);
  const t = frame / FPS;
  const page = pages.find((p) => t >= p.start - 0.05 && t < p.end);
  if (!page) return null;

  const fadeIn = interpolate(t, [page.start - 0.05, page.start + 0.12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const fadeOut = interpolate(t, [page.end - 0.12, page.end], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  const lift = Math.max(
    0,
    ...LIFTED.map(([a, b]) => interpolate(t, [a - 0.25, a, b, b + 0.25], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })),
  );

  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 54 + 110 * lift, pointerEvents: 'none' }}>
      <div
        style={{
          opacity: Math.min(fadeIn, fadeOut),
          maxWidth: 1380,
          padding: '14px 30px 16px',
          borderRadius: 16,
          background: 'rgba(9,9,11,0.82)',
          border: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
          fontFamily: FONT,
          fontSize: 44,
          fontWeight: 600,
          lineHeight: 1.25,
          letterSpacing: -0.3,
          textAlign: 'center',
          textWrap: 'balance',
        }}
      >
        {page.words.map((w, i) => {
          const spoken = t >= w.start - 0.02;
          return (
            <span key={i} style={{ color: spoken ? C.text : 'rgba(250,250,250,0.48)' }}>
              {w.text}
              {i < page.words.length - 1 ? ' ' : ''}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
