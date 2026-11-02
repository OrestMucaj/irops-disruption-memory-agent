import React from 'react';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Check, HelpCircle } from 'lucide-react';

import { Backdrop, LogoChip } from '../components/Chrome';
import { cue, section } from '../timeline';
import { C, FONT, MONO } from '../theme';

/**
 * Records versus judgement, then the product reveal.
 *
 * The record cards are real resolved cases from the demo dataset. The
 * judgement panel holds the one thing those rows don't: what worked.
 */

const CARDS = [
  { f: 'ZZ3043', s: 'FRA → EDI', c: 'technical', d: 259 },
  { f: 'ZZ1176', s: 'OTP → FRA', c: 'technical', d: 237 },
  { f: 'ZZ1085', s: 'LHR → EDI', c: 'weather', d: 145 },
  { f: 'ZZ4469', s: 'MAD → OTP', c: 'crew', d: 89 },
  { f: 'ZZ2852', s: 'JFK → FRA', c: 'crew', d: 180 },
  { f: 'ZZ3225', s: 'FRA → BUD', c: 'technical', d: 274 },
  { f: 'ZZ1509', s: 'LHR → DUB', c: 'crew', d: 96 },
  { f: 'ZZ1912', s: 'BRU → AMS', c: 'technical', d: 352 },
  { f: 'ZZ220', s: 'FRA → OTP', c: 'atc', d: 71 },
];

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

export const IntroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const recordsAt = cue('intro', 's02-problem', 'records,');
  const judgeAt = cue('intro', 's02-problem', 'judgement:');
  const whatAt = cue('intro', 's02-problem', 'what');
  const lostAt = cue('intro', 's02-problem', 'time.', 'end');
  const revealAt = cue('intro', 's03-reveal', 'Meet');
  const nameAt = cue('intro', 's03-reveal', 'IROPS');
  const s3 = section('s03-reveal');
  const tagWords = s3.abs.slice(s3.abs.findIndex((w) => w.text === 'Every'));
  const tagAt = cue('intro', 's03-reveal', 'Every');

  const part1 = interpolate(frame, [revealAt - 14, revealAt + 4], [1, 0], clamp);
  // Records hold the centre alone, then slide over to make room for judgement.
  const makeRoom = interpolate(frame, [judgeAt - 14, judgeAt + 4], [0, 1], { ...clamp, easing: Easing.bezier(0.65, 0, 0.35, 1) });
  const judgeIn = interpolate(frame, [judgeAt - 4, judgeAt + 10], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const logoIn = spring({ frame: frame - revealAt, fps, config: { damping: 14, stiffness: 120 } });
  const nameIn = interpolate(frame, [nameAt - 4, nameAt + 14], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const sweep = interpolate(frame, [nameAt + 6, nameAt + 40], [-30, 130], clamp);

  return (
    <AbsoluteFill>
      <Backdrop />

      {/* records vs judgement */}
      <AbsoluteFill style={{ opacity: part1, padding: '150px 120px 200px', flexDirection: 'row', gap: 70, alignItems: 'center' }}>
        <div style={{ width: 1060, translate: `${(1 - makeRoom) * 310}px 0` }}>
          <Header icon={<Check size={30} color={C.bg} strokeWidth={3} />} tone={C.emerald} text="Records" at={recordsAt} note="kept" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 18, marginTop: 26 }}>
            {CARDS.map((c, i) => {
              const o = interpolate(frame, [4 + i * 3, 16 + i * 3], [0, 1], clamp);
              return (
                <div
                  key={c.f}
                  style={{
                    opacity: o,
                    translate: `0 ${(1 - o) * 26}px`,
                    padding: '18px 20px',
                    borderRadius: 14,
                    background: C.surface,
                    border: `1px solid ${frame > recordsAt ? `${C.emerald}55` : C.surface2}`,
                    fontFamily: FONT,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 30, color: C.text }}>{c.f}</span>
                    <span style={{ fontFamily: MONO, fontSize: 28, color: c.d >= 240 ? C.red : c.d >= 120 ? C.orange : C.amber }}>{c.d}′</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 23, color: C.muted }}>
                    <span>{c.s}</span>
                    <span style={{ padding: '2px 10px', borderRadius: 8, background: C.surface2, color: C.text, fontSize: 20 }}>{c.c}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ flex: 1, opacity: judgeIn, translate: `${(1 - judgeIn) * 40}px 0` }}>
          <Header icon={<HelpCircle size={30} color={C.bg} strokeWidth={3} />} tone={C.amber} text="Judgement" at={judgeAt} note="lost" />
          <div
            style={{
              marginTop: 26,
              height: 344,
              borderRadius: 18,
              border: `3px dashed ${C.amber}88`,
              background: 'rgba(251,191,36,0.05)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 36,
            }}
          >
            <span
              style={{
                fontFamily: FONT,
                fontSize: 44,
                fontWeight: 600,
                fontStyle: 'italic',
                color: C.text,
                textAlign: 'center',
                lineHeight: 1.25,
                opacity: interpolate(frame, [whatAt - 2, whatAt + 10, lostAt + 2, lostAt + 22], [0, 1, 1, 0.12], clamp),
                filter: `blur(${interpolate(frame, [lostAt + 2, lostAt + 22], [0, 7], clamp)}px)`,
              }}
            >
              “What actually worked last time?”
            </span>
          </div>
        </div>
      </AbsoluteFill>

      {/* reveal */}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: frame >= revealAt - 4 ? 1 : 0 }}>
        <div style={{ scale: String(0.6 + 0.4 * logoIn), opacity: logoIn, marginBottom: 46 }}>
          <LogoChip size={150} />
        </div>
        <div style={{ position: 'relative', overflow: 'hidden', padding: '0 20px' }}>
          <div
            style={{
              fontFamily: FONT,
              fontSize: 96,
              fontWeight: 800,
              letterSpacing: -2.5,
              color: C.text,
              opacity: nameIn,
              translate: `0 ${(1 - nameIn) * 30}px`,
            }}
          >
            IROPS Disruption Memory Agent
          </div>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: `linear-gradient(100deg, transparent ${sweep - 12}%, rgba(255,255,255,0.35) ${sweep}%, transparent ${sweep + 12}%)`,
              mixBlendMode: 'overlay',
            }}
          />
        </div>
        <div style={{ marginTop: 34, fontFamily: FONT, fontSize: 48, fontWeight: 500, color: C.muted, letterSpacing: -0.5 }}>
          {tagWords.map((w, i) => {
            const at = tagAt + Math.round((w.start - tagWords[0].start) * fps);
            const o = interpolate(frame, [at - 3, at + 7], [0, 1], clamp);
            const accent = w.text.startsWith('precedent');
            return (
              <span key={i} style={{ opacity: o, color: accent ? C.emerald : undefined, fontWeight: accent ? 700 : undefined, marginRight: '0.24em' }}>
                {w.text}
              </span>
            );
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const Header: React.FC<{ icon: React.ReactNode; tone: string; text: string; at: number; note: string }> = ({ icon, tone, text, at, note }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [at - 4, at + 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18, opacity: Math.max(0.25, o), fontFamily: FONT }}>
      <span style={{ width: 50, height: 50, borderRadius: 14, background: tone, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{icon}</span>
      <span style={{ fontSize: 56, fontWeight: 800, color: C.text, letterSpacing: -1 }}>{text}</span>
      <span style={{ fontSize: 30, fontWeight: 600, color: tone, opacity: o, marginTop: 8 }}>{note}</span>
    </div>
  );
};
