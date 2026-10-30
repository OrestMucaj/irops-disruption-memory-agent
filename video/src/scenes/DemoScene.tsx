import React from 'react';
import { AbsoluteFill, Easing, interpolate, Sequence, staticFile, useCurrentFrame } from 'remotion';
import { Audio } from '@remotion/media';

import { box, centre, FULL, Rect, VIEW_H, VIEW_W } from '../captures';
import { Backdrop, Disclosure, Kicker } from '../components/Chrome';
import { CamKey, ScreenCamera, ShotKey, Spot } from '../components/ScreenCamera';
import { cue, cueSection } from '../timeline';
import { C, FONT, MONO } from '../theme';

/**
 * The product walkthrough, built entirely from captured console states.
 *
 * Every shot is the live demo in a real state (video/capture/capture.cjs). The
 * camera, cursor and spotlights only direct attention; each cut lands on the
 * word that describes it.
 */

const c = (id: string, w: number | string, edge: 'start' | 'end' = 'start') => cue('demo', id, w, edge);
const sec = (id: string, edge: 'start' | 'end' = 'start') => cueSection('demo', id, edge);

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

export const DemoScene: React.FC = () => {
  const frame = useCurrentFrame();

  // --- cue points ------------------------------------------------------------
  const consoleEnd = c('s04-console', 'console.', 'end');
  const zz = c('s04-console', 'ZZ1137:');
  const ninety = c('s04-console', 'ninety');
  const twentyThree = c('s04-console', 'twenty-three');
  const e4 = sec('s04-console', 'end');
  const clickRow = e4 + 6;

  const one = c('s05-plan', 'One');
  const clickRecs = c('s05-plan', 'click:') + 4;
  const embeds = c('s05-plan', 'embeds');
  const finds = c('s05-plan', 'finds');
  const proposes = c('s05-plan', 'proposes');
  const cites = c('s05-plan', 'cites');
  const e5 = sec('s05-plan', 'end');

  const s6 = sec('s06-guardrail');
  const e6 = sec('s06-guardrail', 'end');

  const open = c('s07-precedent', 'Open');
  const clickChip = c('s07-precedent', 'precedent') + 3;
  const desk = c('s07-precedent', 'desk');
  const turned = c('s07-precedent', 'turned');
  const mixed = c('s07-precedent', 'Mixed');
  const e7 = sec('s07-precedent', 'end');

  const s8 = sec('s08-approve');
  const approves = c('s08-approve', 'approves,');
  const every = c('s08-approve', 'every');
  const clickApprove = c('s08-approve', 'decision') - 2;
  const recorded = c('s08-approve', 'recorded.');
  const e8 = sec('s08-approve', 'end');

  const s9 = sec('s09-audit');
  const model = c('s09-audit', 'model,');
  const tokens = c('s09-audit', 'token');
  const latency = c('s09-audit', 'latency,');
  const exact = c('s09-audit', 'exact');
  const e9 = sec('s09-audit', 'end');

  // --- shots -----------------------------------------------------------------
  const shots: ShotKey[] = [
    { from: 0, shot: '01-caseload' },
    { from: ninety - 4, shot: '02-caseload-hover', fade: 5 },
    // A page change: a near-cut, so the two dense pages don't blend.
    { from: clickRow + 3, shot: '03-detail-empty', fade: 3 },
    { from: one + 4, shot: '04-detail-empty-hover', fade: 5 },
    { from: clickRecs + 3, shot: '05-running', fade: 5 },
    { from: proposes, shot: '06-plan', fade: 10 },
    { from: s6 - 4, shot: '07-plan-clean', fade: 10 },
    { from: open + 2, shot: '08-chip-hover', fade: 5 },
    { from: clickChip + 3, shot: '09-precedent', fade: 9 },
    { from: mixed - 2, shot: '10-retrieved', fade: 10 },
    { from: s8 - 4, shot: '12-review-items', fade: 10 },
    { from: every + 2, shot: '13-approve-hover', fade: 5 },
    { from: clickApprove + 3, shot: '14-approving', fade: 5 },
    { from: recorded, shot: '15-approved', fade: 8 },
    { from: s9 - 4, shot: '16-agent-run', fade: 10 },
    { from: exact, shot: '10b-retrieved-after', fade: 10 },
  ];

  // --- camera ----------------------------------------------------------------
  // Wide and steady, so the cursor can always be placed on the dashboard: the
  // whole console while the case is picked, then the full content column
  // (about 1.2x, the sidebar just out of frame) with only short vertical
  // drifts between beats. Spotlights do the pointing, not zooms.
  const column = (y: number): Rect => ({ x: 236, y, w: 1204, h: (1204 * VIEW_H) / VIEW_W });
  const cams: CamKey[] = [
    { at: 0, view: FULL },
    { at: clickRow + 4, view: column(0), dur: 50 },
    // The dialog sits mid-viewport; drift down so its footer clears the captions.
    { at: clickChip + 2, view: column(56), dur: 30 },
    // The sticky decision bar is the last strip of the capture, so this view
    // sits on the image's bottom edge; captions lift for this beat (Captions.tsx).
    { at: s8 - 4, view: column(121), dur: 30 },
    { at: s9 - 4, view: column(0), dur: 30 },
  ];

  // --- cursor ----------------------------------------------------------------
  const row = centre(box('01-caseload', 'row'));
  const recs = centre(box('03-detail-empty', 'getRecs'));
  const chip = centre(box('07-plan-clean', 'chip'));
  const approve = centre(box('13-approve-hover', 'approveAll'));
  const cursors = [
    {
      from: zz - 6,
      to: clickRecs + 14,
      keys: [
        { at: zz, x: 760, y: 640 },
        { at: ninety, x: row.x - 280, y: row.y, dur: 22 },
        { at: clickRow, x: row.x - 280, y: row.y, dur: 1, click: true },
        { at: one + 6, x: recs.x, y: recs.y, dur: 22 },
        { at: clickRecs, x: recs.x, y: recs.y, dur: 1, click: true },
      ],
    },
    {
      from: open - 6,
      to: clickChip + 12,
      keys: [
        { at: open - 6, x: chip.x + 260, y: chip.y + 150 },
        { at: open + 4, x: chip.x, y: chip.y, dur: 20 },
        { at: clickChip, x: chip.x, y: chip.y, dur: 1, click: true },
      ],
    },
    {
      from: approves - 4,
      to: recorded + 18,
      keys: [
        { at: approves, x: 900, y: 640 },
        { at: every + 4, x: approve.x, y: approve.y, dur: 20 },
        { at: clickApprove, x: approve.x, y: approve.y, dur: 1, click: true },
      ],
    },
  ];

  // --- spotlights ------------------------------------------------------------
  const prompt = box('16-agent-run', 'promptTok');
  const completion = box('16-agent-run', 'completionTok');
  const tokenRect: Rect = { x: prompt.x, y: prompt.y, w: completion.x + completion.w - prompt.x, h: prompt.h };
  // All five retrieved cases; the list runs on below the fold. (The tab bar is
  // hidden under the sticky case header in this capture, so it can't be the target.)
  const first = box('10b-retrieved-after', 'prec0');
  const fifth = box('10b-retrieved-after', 'prec4');
  const retrievedList: Rect = { x: first.x, y: first.y, w: first.w, h: fifth.y + fifth.h - first.y };
  const spots: Spot[] = [
    { from: zz + 4, to: ninety - 2, rect: box('01-caseload', 'row'), pad: 4 },
    { from: ninety, to: twentyThree - 2, rect: box('01-caseload', 'delay'), label: '190 min late', tone: C.red, side: 'bottom', pad: 4 },
    // Gone before the click opens the case, so it never sits on the next page.
    { from: twentyThree, to: e4 - 6, rect: box('01-caseload', 'misconnects'), label: '23 misconnecting', tone: C.orange, side: 'bottom', pad: 4 },
    {
      from: cites,
      to: e5 + 6,
      rect: box('06-plan', 'chip'),
      label: 'Cites a past case and its outcome',
      sub: 'ZZ4381 · rated 5/5 · worked',
      side: 'bottom',
      pad: 6,
    },
    {
      from: s6 + 6,
      to: e6,
      rect: box('07-plan-clean', 'gap'),
      label: 'Coverage check, enforced in code',
      sub: 'A missed connection with no action is flagged',
      tone: C.red,
      side: 'bottom',
      pad: 4,
      dim: 0.5,
    },
    { from: desk, to: turned - 2, rect: box('09-precedent', 'did'), pad: 6 },
    { from: turned, to: mixed - 6, rect: box('09-precedent', 'outcome'), pad: 6 },
    {
      from: mixed + 8,
      to: e7 + 8,
      rect: box('10-retrieved', 'prec2'),
      label: 'Rated 3/5: what went wrong comes back too',
      tone: C.amber,
      side: 'top',
      pad: 4,
    },
    {
      from: approves,
      to: every - 4,
      rect: box('12-review-items', 'item0ctl'),
      label: 'Approve · edit · reject',
      sub: 'per action, or all at once',
      side: 'left',
      pad: 6,
    },
    // Raised above the lifted captions, which sit between it and the bar.
    { from: recorded + 4, to: e8 + 16, rect: box('15-approved', 'decisionbar'), label: 'All 21 decisions recorded', side: 'top', pad: 4, dim: 0.42, labelDy: -130 },
    {
      from: model,
      to: tokens - 2,
      rect: box('16-agent-run', 'model'),
      label: 'Amazon Nova Lite on Bedrock',
      side: 'bottom',
      pad: 4,
    },
    { from: tokens, to: latency - 2, rect: tokenRect, label: 'Real token counts, every run', side: 'bottom', pad: 4 },
    { from: latency, to: exact - 6, rect: box('16-agent-run', 'latency'), pad: 4 },
    { from: exact + 6, to: e9 + 22, rect: retrievedList, label: 'The 5 cases this plan was built from', side: 'top', pad: 6, dim: 0.45 },
  ];

  // --- window framing at the start --------------------------------------------
  const flat = interpolate(frame, [consoleEnd - 4, zz + 6], [0, 1], { ...clamp, easing: Easing.bezier(0.65, 0, 0.35, 1) });
  const enter = interpolate(frame, [0, 22], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });

  return (
    <AbsoluteFill>
      <Backdrop />
      <AbsoluteFill style={{ perspective: 2200 }}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            scale: String(0.74 + 0.26 * flat - (1 - enter) * 0.04),
            transform: `rotateX(${(1 - flat) * 8}deg) rotateY(${(1 - flat) * -6}deg)`,
            translate: `0 ${(1 - flat) * 26 + (1 - enter) * 40}px`,
            opacity: enter,
            borderRadius: 22 * (1 - flat),
            boxShadow: `0 ${60 * (1 - flat)}px ${140 * (1 - flat)}px rgba(0,0,0,${0.7 * (1 - flat)}), 0 0 0 ${2 * (1 - flat)}px ${C.surface2}`,
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: -54,
              height: 54,
              borderRadius: '22px 22px 0 0',
              background: '#1c1c20',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '0 22px',
              opacity: 1 - flat,
            }}
          >
            {['#ff5f57', '#febc2e', '#28c840'].map((col) => (
              <span key={col} style={{ width: 15, height: 15, borderRadius: '50%', background: col }} />
            ))}
            <span style={{ marginLeft: 22, fontFamily: FONT, fontSize: 22, color: C.muted }}>IROPS Memory · Operations Console</span>
            <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 19, color: C.dim, background: C.bg, borderRadius: 8, padding: '6px 14px' }}>
              irops-memory-demo-21.s3.us-east-1.amazonaws.com
            </span>
          </div>
          <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: 22 * (1 - flat) }}>
            <ScreenCamera shots={shots} cams={cams} cursors={cursors} spots={spots}>
              <Pipeline embeds={embeds} finds={finds} proposes={proposes} until={cites - 4} />
            </ScreenCamera>
          </div>
        </div>
      </AbsoluteFill>

      {/* Both clear once the console is flat, off the app's own header. */}
      <Kicker n="01" title="Product walkthrough" from={0} to={zz + 45} />
      <Disclosure text="Recorded on the live demo · all data synthetic" from={zz} to={zz + 150} />

      {[clickRow, clickRecs, clickChip, clickApprove].map((at) => (
        <Sequence key={at} from={at - 1} durationInFrames={10}>
          <Audio src={staticFile('sfx/click.wav')} volume={0.55} />
        </Sequence>
      ))}
      <Sequence from={recorded + 2} durationInFrames={24}>
        <Audio src={staticFile('sfx/confirm.wav')} volume={0.32} />
      </Sequence>
      <Sequence from={proposes + 2} durationInFrames={24}>
        <Audio src={staticFile('sfx/confirm.wav')} volume={0.22} />
      </Sequence>
    </AbsoluteFill>
  );
};

/** What "Get recommendations" does, step by step, while the run is in flight. */
const Pipeline: React.FC<{ embeds: number; finds: number; proposes: number; until: number }> = ({ embeds, finds, proposes, until }) => {
  const frame = useCurrentFrame();
  if (frame < embeds - 4 || frame > until + 12) return null;
  const steps = [
    { at: embeds, n: '1', t: 'Embed the case summary' },
    { at: finds, n: '2', t: 'Vector search · resolved cases only' },
    { at: proposes, n: '3', t: 'Propose actions, citing precedent' },
  ];
  const out = interpolate(frame, [until, until + 12], [1, 0], clamp);
  return (
    <AbsoluteFill style={{ alignItems: 'center', paddingTop: 122, opacity: out }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        {steps.map((s, i) => {
          const o = interpolate(frame, [s.at - 4, s.at + 8], [0, 1], clamp);
          const active = frame >= s.at && (i === steps.length - 1 || frame < steps[i + 1].at);
          return (
            <React.Fragment key={s.n}>
              {i > 0 && <span style={{ opacity: o, color: C.dim, fontSize: 24, fontFamily: FONT }}>→</span>}
              <div
                style={{
                  opacity: o,
                  translate: `0 ${(1 - o) * 14}px`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 16px',
                  borderRadius: 12,
                  background: 'rgba(14,14,17,0.94)',
                  border: `1px solid ${active ? C.emerald : C.line}`,
                  boxShadow: active ? `0 0 30px ${C.emerald}44` : '0 12px 30px rgba(0,0,0,0.5)',
                  fontFamily: FONT,
                }}
              >
                <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 18, color: C.bg, background: active ? C.emerald : C.muted, borderRadius: 6, padding: '1px 7px' }}>
                  {s.n}
                </span>
                <span style={{ fontSize: 23, fontWeight: 600, color: C.text }}>{s.t}</span>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
