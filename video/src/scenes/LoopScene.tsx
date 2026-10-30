import React from 'react';
import { AbsoluteFill, Easing, interpolate, Sequence, staticFile, useCurrentFrame } from 'remotion';
import { Audio } from '@remotion/media';
import {
  AlertTriangle,
  Binary,
  Check,
  ClipboardCheck,
  FileText,
  History,
  Pencil,
  Search,
  Sparkles,
  UserCheck,
  X,
} from 'lucide-react';

import zz1137Summary from '../../public/captures/data/zz1137-summary.json';
import neighbours from '../../public/captures/data/neighbours.json';
import { Disclosure, Kicker, LogoChip, Backdrop } from '../components/Chrome';
import { Crop } from '../components/Crop';
import { cue, cueSection } from '../timeline';
import { C, FONT, MONO } from '../theme';

/**
 * The memory loop. The ring is the lifecycle; the centre shows the real
 * artefact for each step — ZZ1137's actual summary text, the actual retrieval
 * predicate, the actual plan — then the real console closing the case, and
 * the real query results before and after it became precedent.
 */

const c = (id: string, w: number | string, edge: 'start' | 'end' = 'start') => cue('loop', id, w, edge);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

const CX = 960;
const CY = 505;
const RX = 650;
const RY = 300;

const NODES = [
  { t: 'New disruption', s: 'ZZ1137 · 190′ · 23 misconnecting', icon: AlertTriangle, tone: C.orange },
  { t: 'Structured summary', s: 'deterministic text', icon: FileText, tone: C.blue },
  { t: 'Embedding', s: 'VECTOR(1024)', icon: Binary, tone: C.violet },
  { t: 'Similar-case retrieval', s: 'resolved precedent only', icon: Search, tone: C.violet },
  { t: 'Recommendations', s: 'typed, cited actions', icon: Sparkles, tone: C.violet },
  { t: 'Human decision', s: 'approve · edit · reject', icon: UserCheck, tone: C.amber },
  { t: 'Recorded outcome', s: 'rated 1–5, with notes', icon: ClipboardCheck, tone: C.emerald },
  { t: 'New precedent', s: 'retrievable next time', icon: History, tone: C.emerald },
];

const pos = (i: number) => {
  const a = ((-90 + i * 45) * Math.PI) / 180;
  return { x: CX + RX * Math.cos(a), y: CY + RY * Math.sin(a) };
};

export const LoopScene: React.FC = () => {
  const frame = useCurrentFrame();

  const T = [
    c('s10-loop', 'Each'),
    c('s10-loop', 'summary'),
    c('s10-loop', 'embedding.'),
    c('s10-loop', 'Similar'),
    c('s10-loop', 'proposes,'),
    c('s10-loop', 'decides.'),
    c('s11-close', 'Record'),
    c('s11-close', 'precedent.'),
  ];
  const transaction = c('s11-close', 'transaction');
  const search = c('s11-close', 'Search');
  const back = c('s11-close', 'ZZ1137');
  const s12 = cueSection('loop', 's12-chatbot');
  const rejected = c('s12-chatbot', 'rejected');
  const unlike = c('s12-chatbot', 'Unlike');

  // Ring dims while the console and query results take the centre.
  const insetOn = interpolate(frame, [T[6] - 8, T[6] + 6, s12 - 10, s12 + 6], [0, 1, 1, 0], clamp);
  const ringBuild = (i: number) => interpolate(frame, [4 + i * 4, 18 + i * 4], [0, 1], clamp);

  // Progress around the ring, in node units.
  let progress = -0.15;
  for (let i = 0; i < T.length; i += 1) {
    const prev = i === 0 ? T[0] - 14 : T[i - 1];
    if (frame >= prev) {
      progress = interpolate(frame, [Math.max(prev, T[i] - 16), T[i]], [i - 1, i], { ...clamp, easing: Easing.inOut(Easing.cubic) });
    }
  }
  const lit = (i: number) => frame >= T[i] - 2;

  const pulseAngle = ((-90 + Math.max(0, progress) * 45) * Math.PI) / 180;
  const pulse = { x: CX + RX * Math.cos(pulseAngle), y: CY + RY * Math.sin(pulseAngle) };

  const centreCard = (() => {
    if (frame < T[1] - 4) return null;
    if (frame < T[2] - 4) return 'summary';
    if (frame < T[3] - 4) return 'embedding';
    if (frame < T[4] - 4) return 'retrieval';
    if (frame < T[5] - 4) return 'plan';
    if (frame < T[6]) return 'decision';
    return null;
  })();
  const cardStart = { summary: T[1], embedding: T[2], retrieval: T[3], plan: T[4], decision: T[5] } as const;

  const loopBack = interpolate(frame, [unlike - 4, unlike + 24], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const n7 = pos(7);
  const n3 = pos(3);

  return (
    <AbsoluteFill>
      <Backdrop />

      {/* ring */}
      <AbsoluteFill style={{ opacity: 1 - insetOn * 0.86, filter: `blur(${insetOn * 4}px)` }}>
        <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
          <ellipse cx={CX} cy={CY} rx={RX} ry={RY} fill="none" stroke={C.line} strokeWidth={3} strokeDasharray="10 12" opacity={ringBuild(0)} />
          <EllipseArc progress={progress} />
          {loopBack > 0 && (
            <path
              d={`M ${n7.x + 60} ${n7.y + 50} Q ${CX} ${CY + 40} ${n3.x - 60} ${n3.y - 50}`}
              fill="none"
              stroke={C.emerald}
              strokeWidth={4}
              strokeDasharray="1400"
              strokeDashoffset={1400 * (1 - loopBack)}
              markerEnd="url(#arrow)"
            />
          )}
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill={C.emerald} />
            </marker>
          </defs>
          {progress > -0.1 && (
            <circle cx={pulse.x} cy={pulse.y} r={11} fill={C.emerald} style={{ filter: `drop-shadow(0 0 12px ${C.emerald})` }} />
          )}
        </svg>

        {/* core */}
        <div
          style={{
            position: 'absolute',
            left: CX - 200,
            top: CY - 110,
            width: 400,
            height: 220,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            opacity: (centreCard ? 0 : 1) * ringBuild(2) * (1 - loopBack),
            fontFamily: FONT,
          }}
        >
          <LogoChip size={92} />
          <span style={{ fontSize: 32, fontWeight: 800, color: C.text }}>CockroachDB</span>
          <span style={{ fontSize: 23, color: C.muted, marginTop: -8, whiteSpace: 'nowrap' }}>rows + vectors, one system</span>
        </div>

        {loopBack > 0 && (
          <div
            style={{
              // On a pill, so the loop-back curve passes under the words rather than through them.
              position: 'absolute',
              left: CX,
              top: CY - 20,
              translate: '-50% -50%',
              opacity: loopBack,
              padding: '10px 22px',
              borderRadius: 14,
              background: 'rgba(9,9,11,0.92)',
              border: `1px solid ${C.emerald}55`,
              whiteSpace: 'nowrap',
              fontFamily: FONT,
              fontSize: 32,
              fontWeight: 700,
              color: C.emerald,
            }}
          >
            the next disruption retrieves this
          </div>
        )}

        {NODES.map((n, i) => {
          const p = pos(i);
          const on = lit(i) || loopBack > 0.6;
          const Icon = n.icon;
          const rejectGlow = i === 5 ? interpolate(frame, [rejected - 4, rejected + 8, unlike + 30, unlike + 44], [0, 1, 1, 0], clamp) : 0;
          return (
            <div
              key={n.t}
              style={{
                // Sized to its content with equal padding either side, centred on its point on the ring.
                position: 'absolute',
                left: p.x,
                top: p.y,
                translate: '-50% -50%',
                borderRadius: 18,
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                padding: '18px 24px',
                whiteSpace: 'nowrap',
                background: on ? 'rgba(24,24,27,0.97)' : 'rgba(24,24,27,0.75)',
                border: `2px solid ${on ? n.tone : C.surface2}`,
                boxShadow: on ? `0 0 34px ${n.tone}40` : 'none',
                opacity: ringBuild(i) * (on ? 1 : 0.55),
                scale: String(on && frame < T[i] + 10 ? 1 + 0.05 * Math.sin(((frame - T[i] + 2) / 12) * Math.PI) : 1),
                fontFamily: FONT,
              }}
            >
              <span style={{ width: 54, height: 54, borderRadius: 14, flex: 'none', background: `${n.tone}22`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon size={30} color={n.tone} strokeWidth={2.2} />
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                <span style={{ fontSize: 27, fontWeight: 700, color: C.text, whiteSpace: 'nowrap' }}>{n.t}</span>
                <span style={{ fontSize: 20, color: C.muted, whiteSpace: 'nowrap' }}>{n.s}</span>
              </span>
              {i === 5 && rejectGlow > 0 && (
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: -68,
                    opacity: rejectGlow,
                    padding: '12px 18px',
                    borderRadius: 12,
                    background: 'rgba(14,14,17,0.95)',
                    border: `2px solid ${C.amber}`,
                    fontSize: 26,
                    fontWeight: 700,
                    color: C.amber,
                    whiteSpace: 'nowrap',
                  }}
                >
                  Rejections are kept too
                </div>
              )}
            </div>
          );
        })}

        {centreCard && (
          <CentreCard kind={centreCard} start={cardStart[centreCard]} />
        )}
      </AbsoluteFill>

      {/* the console closing the case, then retrieval before/after */}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: insetOn, paddingBottom: 60 }}>
        <InsetSequence record={T[6]} transaction={transaction} search={search} back={back} />
      </AbsoluteFill>

      <Kicker n="02" title="The memory loop" from={0} />
      <Disclosure text="Recorded on the live demo · all data synthetic" from={T[6]} />

      <Sequence from={back + 4} durationInFrames={24}>
        <Audio src={staticFile('sfx/confirm.wav')} volume={0.28} />
      </Sequence>
    </AbsoluteFill>
  );
};

/** The travelled part of the ring, drawn as a solid arc over the dashed track. */
const EllipseArc: React.FC<{ progress: number }> = ({ progress }) => {
  if (progress <= 0) return null;
  const steps = Math.max(2, Math.round(progress * 24));
  const pts: string[] = [];
  for (let k = 0; k <= steps; k += 1) {
    const a = ((-90 + (progress * 45 * k) / steps) * Math.PI) / 180;
    pts.push(`${CX + RX * Math.cos(a)},${CY + RY * Math.sin(a)}`);
  }
  return <polyline points={pts.join(' ')} fill="none" stroke={C.emerald} strokeWidth={4} strokeLinecap="round" opacity={0.85} />;
};

const card: React.CSSProperties = {
  position: 'absolute',
  left: CX - 380,
  top: CY - 135,
  width: 760,
  height: 270,
  borderRadius: 20,
  padding: '24px 30px',
  background: 'rgba(14,14,17,0.97)',
  border: `1px solid ${C.line}`,
  boxShadow: '0 30px 80px rgba(0,0,0,0.6)',
  fontFamily: FONT,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

const CardLabel: React.FC<{ children: React.ReactNode; tone?: string }> = ({ children, tone = C.muted }) => (
  <span style={{ fontSize: 21, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase', color: tone }}>{children}</span>
);

const CentreCard: React.FC<{ kind: 'summary' | 'embedding' | 'retrieval' | 'plan' | 'decision'; start: number }> = ({ kind, start }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [start - 4, start + 8], [0, 1], clamp);
  const style = { ...card, opacity: o, translate: `0 ${(1 - o) * 16}px` };

  if (kind === 'summary') {
    const text = zz1137Summary.summary_text.split('. ').slice(0, 4).join('. ') + '. …';
    return (
      <div style={style}>
        <CardLabel tone={C.blue}>summary_text — what the index sees</CardLabel>
        <span style={{ fontFamily: MONO, fontSize: 24, lineHeight: 1.45, color: C.text }}>{text}</span>
      </div>
    );
  }
  if (kind === 'embedding') {
    return (
      <div style={style}>
        <CardLabel tone={C.violet}>case_embeddings.embedding</CardLabel>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 120 }}>
          {Array.from({ length: 64 }, (_, i) => {
            const h = 0.5 + 0.5 * Math.sin(i * 1.7 + 0.6) * Math.cos(i * 0.43);
            const grow = interpolate(frame, [start + i * 0.6, start + 10 + i * 0.6], [0, 1], clamp);
            return <span key={i} style={{ flex: 1, height: `${(12 + 88 * Math.abs(h)) * grow}%`, borderRadius: 3, background: h >= 0 ? C.violet : C.blue, opacity: 0.85 }} />;
          })}
        </div>
        <span style={{ fontFamily: MONO, fontSize: 26, color: C.text }}>VECTOR(1024) · cosine distance</span>
      </div>
    );
  }
  if (kind === 'retrieval') {
    return (
      <div style={style}>
        <CardLabel tone={C.violet}>Hybrid retrieval · one indexed query</CardLabel>
        <span style={{ fontFamily: MONO, fontSize: 27, lineHeight: 1.5, color: C.text, whiteSpace: 'pre' }}>
          {'WHERE e.case_status = '}
          <span style={{ color: C.emerald }}>'resolved'</span>
          {'\nORDER BY e.embedding <=> $1\nLIMIT 5'}
        </span>
        <span style={{ fontSize: 24, color: C.muted }}>→ 5 precedents, joined to the outcomes they produced</span>
      </div>
    );
  }
  if (kind === 'plan') {
    return (
      <div style={style}>
        <CardLabel tone={C.violet}>Proposed for ZZ1137 · Nova Lite</CardLabel>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {['rebook × 20', 'notify × 1'].map((t) => (
            <span key={t} style={{ fontFamily: MONO, fontSize: 28, padding: '8px 16px', borderRadius: 10, background: C.surface2, color: C.text }}>{t}</span>
          ))}
        </div>
        <span style={{ fontSize: 26, color: C.text }}>
          citing <span style={{ fontFamily: MONO, color: C.emerald }}>ZZ4381 · 5/5 · worked</span>
        </span>
        <span style={{ fontSize: 22, color: C.muted }}>status: proposed — nothing has run</span>
      </div>
    );
  }
  return (
    <div style={{ ...style, alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ display: 'flex', gap: 18 }}>
        {[
          { t: 'Approve', i: Check, tone: C.emerald },
          { t: 'Edit', i: Pencil, tone: C.amber },
          { t: 'Reject', i: X, tone: C.red },
        ].map(({ t, i: Icon, tone }) => (
          <span key={t} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 22px', borderRadius: 14, border: `2px solid ${tone}`, color: C.text, fontSize: 30, fontWeight: 700 }}>
            <Icon size={30} color={tone} strokeWidth={3} /> {t}
          </span>
        ))}
      </div>
      <span style={{ fontSize: 26, color: C.muted }}>a person rules on every action</span>
    </div>
  );
};

type Neighbour = { flight_no: string; cause: string; delay_minutes: number | string; outcome_rating: number | string | null; distance: string };

const InsetSequence: React.FC<{ record: number; transaction: number; search: number; back: number }> = ({ record, transaction, search, back }) => {
  const frame = useCurrentFrame();
  // One after another, so two titles are never on screen together.
  const formIn = interpolate(frame, [record - 6, record + 8, transaction - 9, transaction - 1], [0, 1, 1, 0], clamp);
  const doneIn = interpolate(frame, [transaction - 1, transaction + 9, search - 12, search - 4], [0, 1, 1, 0], clamp);
  const listIn = interpolate(frame, [search - 4, search + 10], [0, 1], clamp);

  return (
    <div style={{ position: 'relative', width: 1760, height: 700, fontFamily: FONT }}>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 26, opacity: formIn }}>
        <InsetLabel text="Close the loop: the desk records what happened" />
        <Crop shot="18-close-filled" rect={{ x: 258, y: 464, w: 1160, h: 292 }} width={1720} />
      </div>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 26, opacity: doneIn }}>
        <InsetLabel text="One transaction: outcome + embedding, status → resolved" />
        <Crop shot="19-resolved" rect={{ x: 258, y: 600, w: 1160, h: 186 }} width={1720} />
      </div>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', opacity: listIn }}>
        <NeighbourList back={back} />
      </div>
    </div>
  );
};

const InsetLabel: React.FC<{ text: string }> = ({ text }) => (
  <span style={{ fontSize: 40, fontWeight: 700, color: C.text, letterSpacing: -0.5 }}>{text}</span>
);

const ROW_H = 84;

const NeighbourList: React.FC<{ back: number }> = ({ back }) => {
  const frame = useCurrentFrame();
  // The list makes room first; ZZ1137 then slides into the slot it opened.
  const t = interpolate(frame, [back - 8, back + 8], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const heroIn = interpolate(frame, [back + 4, back + 18], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const beforeRows = neighbours.before as Neighbour[];
  const afterRows = neighbours.after as Neighbour[];
  const flights = Array.from(new Set([...beforeRows, ...afterRows].map((r) => r.flight_no)));
  const rowFor = (f: string) => afterRows.find((r) => r.flight_no === f) ?? beforeRows.find((r) => r.flight_no === f)!;

  return (
    <div style={{ width: 1460, padding: '30px 38px', borderRadius: 22, background: 'rgba(14,14,17,0.97)', border: `1px solid ${C.line}`, boxShadow: '0 40px 100px rgba(0,0,0,0.6)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 42, fontWeight: 800, color: C.text }}>
          Nearest resolved cases to <span style={{ fontFamily: MONO, color: C.blue }}>{neighbours.flight_no}</span>
        </span>
        <span style={{ fontSize: 28, color: C.muted }}>{neighbours.cause} · {neighbours.delay_minutes}′</span>
      </div>
      <div style={{ fontFamily: MONO, fontSize: 24, color: C.dim, marginBottom: 20, whiteSpace: 'nowrap' }}>case_status = 'resolved' · ORDER BY embedding {'<=>'} · LIMIT 5 · read-only via MCP</div>
      <div style={{ position: 'relative', height: ROW_H * 5 }}>
        {flights.map((f) => {
          const bi = beforeRows.findIndex((r) => r.flight_no === f);
          const ai = afterRows.findIndex((r) => r.flight_no === f);
          const r = rowFor(f);
          const fromY = bi === -1 ? ai * ROW_H : bi * ROW_H;
          const toY = ai === -1 ? 5 * ROW_H : ai * ROW_H;
          const y = fromY + (toY - fromY) * t;
          const hero = f === 'ZZ1137';
          // The row that drops out is gone before it would leave the panel.
          const o = hero ? heroIn : ai === -1 ? Math.max(0, 1 - 2 * t) : 1;
          const rating = r.outcome_rating === null ? null : Number(r.outcome_rating);
          return (
            <div
              key={f}
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: y,
                height: ROW_H - 10,
                opacity: o,
                display: 'flex',
                alignItems: 'center',
                gap: 28,
                padding: '0 22px',
                borderRadius: 14,
                background: hero ? 'rgba(52,211,153,0.12)' : C.surface,
                border: `2px solid ${hero ? C.emerald : 'transparent'}`,
                fontSize: 32,
                color: C.text,
                translate: hero ? `${(1 - heroIn) * -60}px 0` : undefined,
              }}
            >
              <span style={{ fontFamily: MONO, color: C.dim, width: 40 }}>{Math.min(5, Math.round(y / ROW_H) + 1)}</span>
              <span style={{ fontFamily: MONO, fontWeight: 700, width: 150 }}>{f}</span>
              <span style={{ width: 170, color: C.muted }}>{r.cause.replace('_', '-')}</span>
              <span style={{ fontFamily: MONO, width: 110, color: C.muted }}>{r.delay_minutes}′</span>
              <span style={{ width: 120, fontFamily: MONO, fontWeight: 700, color: rating === null ? C.dim : rating >= 4 ? C.emerald : rating === 3 ? C.amber : C.red }}>
                {rating === null ? '—' : `${rating}/5`}
              </span>
              <span style={{ fontFamily: MONO, color: C.dim, width: 270, whiteSpace: 'nowrap' }}>dist {r.distance}</span>
              {hero && <span style={{ marginLeft: 'auto', fontSize: 26, fontWeight: 700, color: C.emerald, whiteSpace: 'nowrap' }}>resolved a moment ago</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
};
