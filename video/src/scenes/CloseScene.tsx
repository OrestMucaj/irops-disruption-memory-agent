import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';

import { Backdrop, LogoChip } from '../components/Chrome';
import { cue, cueSection, section } from '../timeline';
import { C, FONT, MONO } from '../theme';

/** The closing line, set in time with the voice, then the end card. */

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

const STACK = ['CockroachDB · vector index + MCP', 'Amazon Bedrock · Titan V2 + Nova Lite', 'AWS Lambda', 'Amazon S3', 'TypeScript · Vue 3'];

const GitHubMark: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill={C.text}>
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

export const CloseScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = section('s17-close');
  const first = cue('close', 's17-close', 0);
  const end = cueSection('close', 's17-close', 'end');

  const lift = interpolate(frame, [end - 2, end + 22], [0, 1], { ...clamp, easing: Easing.bezier(0.65, 0, 0.35, 1) });
  const card = (d: number) => interpolate(frame, [end + 8 + d, end + 24 + d], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });

  const line1 = s.abs.slice(0, 4);
  const line2 = s.abs.slice(4);
  const word = (w: (typeof s.abs)[number], i: number, accent: boolean) => {
    const at = first + Math.round((w.start - s.abs[0].start) * fps);
    const o = interpolate(frame, [at - 3, at + 7], [0, 1], clamp);
    return (
      <span key={i} style={{ opacity: o, display: 'inline-block', translate: `0 ${(1 - o) * 16}px`, color: accent ? C.emerald : C.text, marginRight: '0.24em' }}>
        {w.text}
      </span>
    );
  };

  return (
    <AbsoluteFill>
      <Backdrop glow={1.2} />
      <AbsoluteFill style={{ alignItems: 'center', fontFamily: FONT }}>
        <div
          style={{
            position: 'absolute',
            top: interpolate(lift, [0, 1], [400, 140]),
            width: 1700,
            textAlign: 'center',
            fontSize: interpolate(lift, [0, 1], [84, 46]),
            fontWeight: 800,
            letterSpacing: interpolate(lift, [0, 1], [-2, -0.8]),
            lineHeight: 1.15,
          }}
        >
          <div>{line1.map((w, i) => word(w, i, false))}</div>
          <div>{line2.map((w, i) => word(w, i, i >= 3))}</div>
        </div>

        <div style={{ position: 'absolute', top: 330, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 30, opacity: card(0), translate: `0 ${(1 - card(0)) * 24}px` }}>
            <LogoChip size={110} />
            <span style={{ fontSize: 76, fontWeight: 800, color: C.text, letterSpacing: -2 }}>IROPS Disruption Memory Agent</span>
          </div>
          <div style={{ marginTop: 22, fontSize: 36, color: C.muted, opacity: card(4) }}>
            An operational-memory agent for airline disruption desks
          </div>
          <div style={{ marginTop: 40, display: 'flex', gap: 12, justifyContent: 'center', opacity: card(8) }}>
            {STACK.map((t) => (
              <span key={t} style={{ padding: '10px 18px', borderRadius: 12, background: C.surface, border: `1px solid ${C.line}`, fontSize: 24, fontWeight: 600, color: C.text, whiteSpace: 'nowrap' }}>
                {t}
              </span>
            ))}
          </div>
          <div
            style={{
              marginTop: 46,
              display: 'flex',
              alignItems: 'center',
              gap: 18,
              padding: '18px 30px',
              borderRadius: 16,
              background: 'rgba(24,24,27,0.97)',
              border: `2px solid ${C.emerald}88`,
              opacity: card(12),
              scale: String(0.96 + 0.04 * card(12)),
            }}
          >
            <GitHubMark size={40} />
            <span style={{ fontFamily: MONO, fontSize: 34, fontWeight: 500, color: C.text }}>github.com/OrestMucaj/irops-disruption-memory-agent</span>
          </div>
          <div style={{ marginTop: 18, display: 'flex', alignItems: 'baseline', gap: 14, opacity: card(14) }}>
            <span style={{ fontSize: 24, fontWeight: 700, letterSpacing: 2, color: C.emerald }}>LIVE DEMO</span>
            <span style={{ fontFamily: MONO, fontSize: 25, color: C.muted }}>irops-memory-demo-21.s3.us-east-1.amazonaws.com/index.html</span>
          </div>
          <div style={{ marginTop: 30, fontSize: 32, fontWeight: 600, color: C.text, opacity: card(18) }}>Built by Orest Mucaj</div>
        </div>

        <div style={{ position: 'absolute', bottom: 54, fontSize: 22, color: C.dim, opacity: card(20) }}>
          Built for the CockroachDB × AWS “Build with Agentic Memory” hackathon · all data synthetic
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
