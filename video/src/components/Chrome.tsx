import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { Database } from 'lucide-react';

import { C, FONT, LOGO_GRADIENT, MONO } from '../theme';

/** Ambient backdrop: the console's zinc, a faint grid, two slow brand glows. */
export const Backdrop: React.FC<{ glow?: number }> = ({ glow = 1 }) => {
  const frame = useCurrentFrame();
  const drift = Math.sin(frame / 140) * 40;
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg, overflow: 'hidden' }}>
      <AbsoluteFill
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
          maskImage: 'radial-gradient(ellipse at 50% 45%, black 25%, transparent 80%)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 1100,
          height: 1100,
          left: -380 + drift,
          top: -520,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${C.emeraldDeep}33, transparent 62%)`,
          opacity: glow,
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 1200,
          height: 1200,
          right: -460 - drift,
          bottom: -640,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${C.violetDeep}30, transparent 62%)`,
          opacity: glow,
        }}
      />
    </AbsoluteFill>
  );
};

/** The console's logo chip: database glyph on the emerald-to-violet gradient. */
export const LogoChip: React.FC<{ size?: number }> = ({ size = 120 }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: size * 0.3,
      background: LOGO_GRADIENT,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: `0 ${size * 0.15}px ${size * 0.5}px ${C.emeraldDeep}40`,
    }}
  >
    <Database size={size * 0.48} color="#fff" strokeWidth={2.2} />
  </div>
);

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** Fades in after `from`; with `to`, fades out again from there. */
const presence = (frame: number, inAt: number, to?: number) =>
  Math.min(interpolate(frame, [inAt, inAt + 14], [0, 1], clamp), to === undefined ? 1 : interpolate(frame, [to, to + 14], [1, 0], clamp));

/**
 * Chapter kicker, top left. Over the console it takes a `to`, so it doesn't sit
 * on the app's own header for the whole chapter.
 */
export const Kicker: React.FC<{ n: string; title: string; from?: number; to?: number }> = ({ n, title, from = 0, to }) => {
  const frame = useCurrentFrame();
  const o = presence(frame, from + 6, to);
  return (
    <div
      style={{
        position: 'absolute',
        left: 56,
        top: 44,
        opacity: o,
        translate: `${interpolate(o, [0, 1], [-14, 0])}px 0`,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '10px 18px 10px 12px',
        borderRadius: 12,
        background: 'rgba(9,9,11,0.82)',
        border: '1px solid rgba(255,255,255,0.08)',
        fontFamily: FONT,
      }}
    >
      <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 22, color: C.bg, background: C.emerald, borderRadius: 7, padding: '3px 9px' }}>{n}</span>
      <span style={{ fontSize: 24, fontWeight: 700, letterSpacing: 2.2, textTransform: 'uppercase', color: C.text }}>{title}</span>
    </div>
  );
};

/** Disclosure badge, top right; `to` as for the kicker. */
export const Disclosure: React.FC<{ text: string; from?: number; to?: number }> = ({ text, from = 0, to }) => {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  const o = presence(frame, from + 10, to);
  return (
    <div
      style={{
        position: 'absolute',
        right: 56,
        top: 48,
        maxWidth: width * 0.42,
        opacity: o,
        padding: '10px 16px',
        borderRadius: 12,
        background: 'rgba(9,9,11,0.82)',
        border: `1px solid ${C.amber}55`,
        fontFamily: FONT,
        fontSize: 21,
        fontWeight: 500,
        color: '#fde68a',
        lineHeight: 1.3,
        textAlign: 'right',
      }}
    >
      {text}
    </div>
  );
};

/** Wraps a scene with a crossfade in and out. */
export const SceneFade: React.FC<{ fadeIn?: number; fadeOut?: number; children: React.ReactNode }> = ({
  fadeIn = 16,
  fadeOut = 16,
  children,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const o = Math.min(
    fadeIn ? interpolate(frame, [0, fadeIn], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 1,
    fadeOut ? interpolate(frame, [durationInFrames - fadeOut, durationInFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 1,
  );
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};
