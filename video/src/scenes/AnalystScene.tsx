import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion';
import { ListChecks, ServerCog, ShieldCheck, Terminal } from 'lucide-react';

import { box } from '../captures';
import { Backdrop, Disclosure, Kicker } from '../components/Chrome';
import { Crop } from '../components/Crop';
import { cue } from '../timeline';
import { C, FONT, MONO } from '../theme';

/**
 * Ask the memory. The chat panel is the real console UI; the three layers are
 * the read-only enforcement in src/mcp/analyst.ts plus the MCP server's own
 * limits; the terminal line is the real output of scripts/analyst-guardrails.mjs.
 * The analyst itself needs CockroachDB Cloud's Managed MCP Server, so no
 * answer is shown — the badge says so.
 */

const c = (w: string, edge: 'start' | 'end' = 'start') => cue('analyst', 's13-analyst', w, edge);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

const LAYERS = [
  { icon: ListChecks, t: 'Tool allowlist', s: 'select_query · get_table_schema · list_tables' },
  { icon: ShieldCheck, t: 'Statement check', s: 'SELECT / WITH only · no chaining · no DDL or DML · no system schemas' },
  { icon: ServerCog, t: 'MCP server limits', s: 'one statement per call · 20 s timeout · 10 KiB response cap' },
];

export const AnalystScene: React.FC = () => {
  const frame = useCurrentFrame();
  const english = c('English:');
  const writes = c('writes');
  const mcp = c('MCP');
  const readOnly = c('read-only');
  const guard = c('guardrails.');

  const chatIn = interpolate(frame, [6, 26], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const layerAt = [writes, readOnly, guard - 6];

  return (
    <AbsoluteFill>
      <Backdrop />
      <AbsoluteFill style={{ flexDirection: 'row', alignItems: 'center', padding: '120px 120px 170px', gap: 90 }}>
        <div style={{ perspective: 1800, opacity: chatIn }}>
          <div style={{ transform: `rotateY(${8 - chatIn * 4}deg) translateX(${(1 - chatIn) * -40}px)` }}>
            <Crop shot="21-chat" rect={box('21-chat', 'chatwin')} width={600} style={{ borderRadius: 24 }} />
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 22, fontFamily: FONT }}>
          <div style={{ opacity: interpolate(frame, [english - 4, english + 10], [0, 1], clamp) }}>
            <div style={{ fontSize: 60, fontWeight: 800, color: C.text, letterSpacing: -1.2, lineHeight: 1.1 }}>
              Plain-English questions,
              <br />
              <span style={{ color: C.emerald }}>model-written SQL</span>
            </div>
            <div style={{ display: 'flex', gap: 14, marginTop: 20, opacity: interpolate(frame, [mcp - 4, mcp + 8], [0, 1], clamp) }}>
              <Chip text="CockroachDB Managed MCP Server" tone={C.violet} />
              <Chip text="never touches the app's pg pool" tone={C.blue} />
            </div>
          </div>

          {LAYERS.map((l, i) => {
            const o = interpolate(frame, [layerAt[i] - 4, layerAt[i] + 10], [0, 1], clamp);
            const Icon = l.icon;
            return (
              <div
                key={l.t}
                style={{
                  opacity: o,
                  translate: `${(1 - o) * 30}px 0`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 20,
                  padding: '18px 24px',
                  borderRadius: 16,
                  background: 'rgba(24,24,27,0.95)',
                  border: `1px solid ${C.line}`,
                }}
              >
                <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 24, color: C.bg, background: C.emerald, borderRadius: 8, padding: '4px 11px' }}>{i + 1}</span>
                <Icon size={36} color={C.emerald} strokeWidth={2.2} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 32, fontWeight: 700, color: C.text }}>{l.t}</span>
                  <span style={{ fontSize: 24, color: C.muted }}>{l.s}</span>
                </div>
              </div>
            );
          })}

          <div
            style={{
              opacity: interpolate(frame, [guard + 2, guard + 14], [0, 1], clamp),
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              padding: '16px 22px',
              borderRadius: 14,
              background: '#050506',
              border: `1px solid ${C.surface2}`,
              fontFamily: MONO,
              fontSize: 25,
            }}
          >
            <Terminal size={28} color={C.dim} />
            <span style={{ color: C.dim }}>node scripts/analyst-guardrails.mjs</span>
            <span style={{ color: C.emerald, fontWeight: 700, marginLeft: 'auto' }}>All 20 guardrail cases held.</span>
          </div>
        </div>
      </AbsoluteFill>

      <Kicker n="03" title="Ask the memory" from={0} />
      <Disclosure text="Needs CockroachDB Cloud's Managed MCP Server, so no live answer in this local recording" from={0} />
    </AbsoluteFill>
  );
};

const Chip: React.FC<{ text: string; tone: string }> = ({ text, tone }) => (
  <span style={{ padding: '10px 18px', borderRadius: 12, border: `1px solid ${tone}88`, background: `${tone}18`, color: C.text, fontSize: 25, fontWeight: 600 }}>{text}</span>
);
