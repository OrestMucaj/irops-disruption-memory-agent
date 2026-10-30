import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion';

import { Backdrop } from '../components/Chrome';
import { cue, section } from '../timeline';
import { C, FONT, MONO } from '../theme';

/**
 * Opening: a split-flap disruption board settling on the demo's real flights
 * (the synthetic caseload, sorted by departure), ZZ1137 flagged. Then the board
 * recedes and the question is set word by word in time with the voice.
 */

type Row = { time: string; flight: string; from: string; to: string; delay: number; hero?: boolean };

const ROWS: Row[] = [
  { time: '06:00', flight: 'ZZ1912', from: 'BRU', to: 'AMS', delay: 352 },
  { time: '08:50', flight: 'ZZ2052', from: 'LHR', to: 'ORD', delay: 86 },
  { time: '14:15', flight: 'ZZ1137', from: 'CDG', to: 'OSL', delay: 190, hero: true },
  { time: '18:00', flight: 'ZZ4004', from: 'CDG', to: 'HEL', delay: 75 },
  { time: '18:35', flight: 'ZZ2852', from: 'JFK', to: 'FRA', delay: 180 },
  { time: '18:40', flight: 'ZZ4071', from: 'AMS', to: 'VIE', delay: 104 },
  { time: '20:55', flight: 'ZZ3043', from: 'FRA', to: 'EDI', delay: 259 },
];

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+:';

const hash = (a: number, b: number) => {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return Math.abs(h ^ (h >>> 16));
};

const FlapText: React.FC<{ text: string; row: number; col0: number; color: string; settleBase: number; width?: number }> = ({
  text,
  row,
  col0,
  color,
  settleBase,
  width,
}) => {
  const frame = useCurrentFrame();
  const chars = text.padEnd(width ?? text.length, ' ').split('');
  return (
    <div style={{ display: 'flex', gap: 5 }}>
      {chars.map((ch, i) => {
        const col = col0 + i;
        const settle = settleBase + col * 0.9;
        const settled = frame >= settle;
        const shown = settled ? ch : ch === ' ' ? ' ' : CHARSET[hash(row * 97 + col, Math.floor(frame / 2)) % CHARSET.length];
        const flipping = !settled && ch !== ' ';
        return (
          <div
            key={i}
            style={{
              width: 40,
              height: 60,
              borderRadius: 6,
              background: flipping ? '#1d1d22' : '#141418',
              boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.04), 0 2px 6px rgba(0,0,0,0.5)',
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: MONO,
              fontWeight: 700,
              fontSize: 40,
              color: flipping ? '#d4d4d8' : color,
            }}
          >
            {shown}
            <div style={{ position: 'absolute', left: 0, right: 0, top: 29, height: 2, background: 'rgba(0,0,0,0.75)' }} />
          </div>
        );
      })}
    </div>
  );
};

export const HookScene: React.FC = () => {
  const frame = useCurrentFrame();
  const qStart = cue('hook', 's01-hook', 'What');
  const qEnd = cue('hook', 's01-hook', 'one?', 'end');
  const countsEnd = cue('hook', 's01-hook', 'counts.', 'end');
  const s = section('s01-hook');
  const qWords = s.abs.slice(s.abs.findIndex((w) => w.text === 'What'));

  // The board is already softening when the first word lands on it.
  const recede = interpolate(frame, [qStart - 14, qStart + 6], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.65, 0, 0.35, 1),
  });
  const push = interpolate(frame, [0, qStart], [0.9, 1.0], { extrapolateRight: 'clamp', easing: Easing.out(Easing.quad) });
  const heroGlow = interpolate(frame, [52, 62], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const statsIn = (d: number) =>
    interpolate(frame, [countsEnd - 30 + d, countsEnd - 16 + d], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: Easing.out(Easing.cubic),
    });

  return (
    <AbsoluteFill>
      <Backdrop glow={0.7} />
      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          perspective: 1600,
          opacity: 1 - recede * 0.72,
          filter: `blur(${recede * 9}px)`,
        }}
      >
        <div
          style={{
            scale: String(push - recede * 0.06),
            rotate: `x ${interpolate(frame, [0, qStart], [16, 7], { extrapolateRight: 'clamp' })}deg`,
            padding: '34px 44px 40px',
            borderRadius: 26,
            background: 'linear-gradient(180deg, #0f0f12, #0b0b0d)',
            border: `1px solid ${C.surface2}`,
            boxShadow: '0 50px 120px rgba(0,0,0,0.7)',
            translate: '0 -40px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 22, fontFamily: FONT }}>
            <span style={{ fontSize: 30, fontWeight: 800, letterSpacing: 6, color: C.amber }}>DISRUPTIONS</span>
            <span style={{ fontSize: 20, fontWeight: 500, letterSpacing: 1.5, color: C.dim }}>SYNTHETIC CASELOAD · ZULU</span>
          </div>
          <div style={{ display: 'flex', gap: 28, fontFamily: FONT, fontSize: 17, letterSpacing: 2.5, color: C.dim, marginBottom: 10, paddingLeft: 4 }}>
            <span style={{ width: 225 }}>STD</span>
            <span style={{ width: 270 }}>FLIGHT</span>
            <span style={{ width: 400 }}>SECTOR</span>
            <span>STATUS</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {ROWS.map((r, i) => {
              const base = 4 + i * 4 + (r.hero ? 14 : 0);
              const status = `DELAYED +${r.delay}`;
              const color = r.hero ? C.red : C.text;
              return (
                <div
                  key={r.flight}
                  style={{
                    display: 'flex',
                    gap: 28,
                    padding: 4,
                    borderRadius: 10,
                    background: r.hero ? `rgba(248,113,113,${0.1 * heroGlow})` : 'transparent',
                    boxShadow: r.hero ? `0 0 0 ${2 * heroGlow}px ${C.red}AA, 0 0 ${40 * heroGlow}px ${C.red}44` : 'none',
                  }}
                >
                  <div style={{ width: 225 }}>
                    <FlapText text={r.time} row={i} col0={0} color={C.text} settleBase={base} />
                  </div>
                  <div style={{ width: 270 }}>
                    <FlapText text={r.flight} row={i} col0={5} color={r.hero ? C.text : C.muted} settleBase={base} />
                  </div>
                  <div style={{ width: 400, display: 'flex', gap: 14, alignItems: 'center' }}>
                    <FlapText text={r.from} row={i} col0={11} color={C.muted} settleBase={base} />
                    <span style={{ color: C.dim, fontSize: 30, fontFamily: FONT }}>→</span>
                    <FlapText text={r.to} row={i} col0={14} color={C.muted} settleBase={base} />
                  </div>
                  <FlapText text={status} row={i} col0={17} color={r.hero ? color : C.amber} settleBase={base} width={12} />
                </div>
              );
            })}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 22, marginTop: 6, translate: '0 -10px' }}>
          {[
            { big: '190 min', small: 'late', tone: C.red, d: 0 },
            { big: '23', small: 'passengers misconnecting', tone: C.orange, d: 4 },
          ].map((s) => (
            <div
              key={s.big}
              style={{
                opacity: statsIn(s.d),
                translate: `0 ${(1 - statsIn(s.d)) * 24}px`,
                display: 'flex',
                alignItems: 'baseline',
                gap: 14,
                padding: '14px 28px',
                borderRadius: 16,
                background: 'rgba(14,14,17,0.92)',
                border: `1px solid ${s.tone}66`,
                fontFamily: FONT,
              }}
            >
              <span style={{ fontSize: 52, fontWeight: 800, color: s.tone, letterSpacing: -1 }}>{s.big}</span>
              <span style={{ fontSize: 30, fontWeight: 600, color: C.text }}>{s.small}</span>
            </div>
          ))}
        </div>
      </AbsoluteFill>

      {/* Out before the crossfade, so it never sits on the intro's cards. */}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', padding: '0 160px', opacity: interpolate(frame, [qEnd + 16, qEnd + 30], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) }}>
        <div style={{ fontFamily: FONT, fontSize: 86, fontWeight: 800, letterSpacing: -2, lineHeight: 1.12, textAlign: 'center', maxWidth: 1500, textWrap: 'balance' }}>
          {qWords.map((w, i) => {
            const at = qStart + Math.round((w.start - qWords[0].start) * 30);
            const o = interpolate(frame, [at - 3, at + 7], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
            const accent = i >= qWords.length - 2;
            return (
              <span key={i} style={{ opacity: o, display: 'inline-block', translate: `0 ${(1 - o) * 18}px`, color: accent ? C.emerald : C.text, marginRight: '0.26em' }}>
                {w.text}
              </span>
            );
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
