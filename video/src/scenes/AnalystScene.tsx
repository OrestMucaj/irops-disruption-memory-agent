import React from 'react';
import { AbsoluteFill, interpolate, Sequence, staticFile, useCurrentFrame } from 'remotion';
import { Audio } from '@remotion/media';
import { ListChecks, ServerCog, ShieldCheck } from 'lucide-react';

import { box, centre, frameRect } from '../captures';
import { Kicker } from '../components/Chrome';
import { CamKey, ScreenCamera, ShotKey, Spot } from '../components/ScreenCamera';
import { cue, cueSection } from '../timeline';
import { C, FONT, MONO } from '../theme';

/**
 * Ask the memory, on the live demo: the question goes in, Nova Lite writes
 * the SQL, it runs through CockroachDB's Managed MCP Server, and the answer
 * comes back with the query and the rows it read. The three read-only layers
 * are src/mcp/analyst.ts's allowlist and statement check plus the server's
 * own limits.
 */

const c = (id: string, w: string, edge: 'start' | 'end' = 'start') => cue('analyst', id, w, edge);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

const LAYERS = [
  { icon: ListChecks, t: 'Tool allowlist', s: 'select_query · get_table_schema · list_tables' },
  { icon: ShieldCheck, t: 'Statement check', s: 'SELECT / WITH only · no chaining · no DDL or DML' },
  { icon: ServerCog, t: 'MCP server limits', s: 'one statement per call · 20 s timeout · 10 KiB cap' },
];

export const AnalystScene: React.FC = () => {
  const frame = useCurrentFrame();
  const english = c('s13-analyst', 'English.', 'end');
  const click = english + 4;
  const sql = c('s13-analyst', 'SQL');
  const mcp = c('s13-analyst', 'MCP');
  const readOnly = c('s13-analyst', 'read-only');
  const s13b = cueSection('analyst', 's13b-answer');
  const answer = c('s13b-answer', 'answer');
  const rows = c('s13b-answer', 'rows');
  const end = cueSection('analyst', 's13b-answer', 'end');

  const shots: ShotKey[] = [
    { from: 0, shot: '21-chat' },
    { from: click + 3, shot: '22-chat-thinking', fade: 5 },
    { from: click + 66, shot: '23-chat-answer', fade: 8 },
  ];

  const chatView = frameRect(box('21-chat', 'chatwin'), 1.0);
  // Answer at the top, returned rows well clear of the captions.
  const closeView = { x: 640, y: 203, w: 800, h: 450 };
  const cams: CamKey[] = [
    { at: 0, view: chatView },
    { at: s13b - 10, view: closeView, dur: 26 },
  ];

  const sugg = centre(box('21-chat', 'sugg'));
  const cursors = [
    {
      from: 8,
      to: click + 14,
      keys: [
        { at: 10, x: sugg.x - 220, y: sugg.y + 160 },
        { at: click - 6, x: sugg.x - 60, y: sugg.y, dur: 24 },
        { at: click, x: sugg.x - 60, y: sugg.y, dur: 1, click: true },
      ],
    },
  ];

  const spots: Spot[] = [
    { from: sql, to: mcp - 4, rect: box('24-chat-sql', 'sql'), label: 'SQL written by Nova Lite', side: 'left', pad: 6, dim: 0.45 },
    { from: mcp, to: s13b - 12, rect: box('23-chat-answer', 'qtoggle'), label: '1 query · read-only via MCP', side: 'left', pad: 6, dim: 0.45 },
    { from: answer, to: rows - 4, rect: box('23-chat-answer', 'answer'), pad: 6 },
    { from: rows, to: end + 20, rect: box('24-chat-sql', 'rows'), label: 'The rows behind the answer', side: 'left', pad: 6, dim: 0.5 },
  ];

  const panel = interpolate(frame, [readOnly - 6, readOnly + 8, s13b - 14, s13b - 2], [0, 1, 1, 0], clamp);

  return (
    <AbsoluteFill>
      <ScreenCamera shots={shots} cams={cams} cursors={cursors} spots={spots} />

      {panel > 0 && (
        <AbsoluteFill style={{ opacity: panel, background: 'linear-gradient(90deg, rgba(9,9,11,0.94) 0%, rgba(9,9,11,0.9) 52%, transparent 66%)' }}>
          <div style={{ position: 'absolute', left: 100, top: 230, width: 900, display: 'flex', flexDirection: 'column', gap: 20, fontFamily: FONT }}>
            <div style={{ fontSize: 54, fontWeight: 800, color: C.text, letterSpacing: -1.2 }}>Read-only, enforced by the app</div>
            {LAYERS.map((l, i) => {
              const o = interpolate(frame, [readOnly + i * 6, readOnly + 10 + i * 6], [0, 1], clamp);
              const Icon = l.icon;
              return (
                <div
                  key={l.t}
                  style={{
                    opacity: o,
                    translate: `${(1 - o) * -24}px 0`,
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
          </div>
        </AbsoluteFill>
      )}

      <Kicker n="03" title="Ask the memory" from={0} />
      <Sequence from={click - 1} durationInFrames={10}>
        <Audio src={staticFile('sfx/click.wav')} volume={0.55} />
      </Sequence>
      <Sequence from={click + 66} durationInFrames={24}>
        <Audio src={staticFile('sfx/confirm.wav')} volume={0.22} />
      </Sequence>
    </AbsoluteFill>
  );
};
