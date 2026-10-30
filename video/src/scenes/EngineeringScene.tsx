import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion';
import { Box, Cloud, Cpu, Database, Globe, Zap } from 'lucide-react';

import EXPLAIN from '../data/explain.json';
import { Backdrop, Kicker } from '../components/Chrome';
import { cue } from '../timeline';
import { C, FONT, MONO } from '../theme';

/**
 * Under the hood, in three beats that each say why:
 *  1. one database for state and memory, written in one transaction
 *     (the statements are the ones resolveCase runs, in order);
 *  2. the case_status prefix column filtering inside the vector index — the
 *     EXPLAIN lines (src/data/explain.json) are lifted from this build's own
 *     `npm run verify:schema` output;
 *  3. the AWS shape that lets it scale to zero.
 */

const c = (id: string, w: string, edge: 'start' | 'end' = 'start') => cue('engineering', id, w, edge);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

export const EngineeringScene: React.FC = () => {
  const frame = useCurrentFrame();
  const one = c('s14-db', 'one');
  const commit = c('s14-db', 'commit');
  const noSync = c('s14-db', 'no');
  const prefix = c('s15-index', 'case-status');
  const inside = c('s15-index', 'inside');
  const aws = c('s16-aws', 'AWS,');
  const bedrock = c('s16-aws', 'Bedrock');
  const lambda = c('s16-aws', 'Lambda');
  const s3 = c('s16-aws', 'S3');
  const zero = c('s16-aws', 'zero');

  const beat1 = interpolate(frame, [prefix - 22, prefix - 8], [1, 0], clamp);
  const beat2 = interpolate(frame, [prefix - 14, prefix, aws - 18, aws - 4], [0, 1, 1, 0], clamp);
  const beat3 = interpolate(frame, [aws - 10, aws + 4], [0, 1], clamp);

  return (
    <AbsoluteFill>
      <Backdrop />
      {beat1 > 0 && (
        <AbsoluteFill style={{ opacity: beat1 }}>
          <OneDatabase one={one} commit={commit} noSync={noSync} />
        </AbsoluteFill>
      )}
      {beat2 > 0 && (
        <AbsoluteFill style={{ opacity: beat2 }}>
          <PrefixIndex start={prefix} inside={inside} />
        </AbsoluteFill>
      )}
      {beat3 > 0 && (
        <AbsoluteFill style={{ opacity: beat3 }}>
          <AwsShape start={aws} bedrock={bedrock} lambda={lambda} s3={s3} zero={zero} />
        </AbsoluteFill>
      )}
      <Kicker n="04" title="Under the hood" from={0} />
    </AbsoluteFill>
  );
};

const Title: React.FC<{ text: string; sub: string }> = ({ text, sub }) => (
  <div style={{ fontFamily: FONT, marginBottom: 34 }}>
    <div style={{ fontSize: 64, fontWeight: 800, color: C.text, letterSpacing: -1.4 }}>{text}</div>
    <div style={{ fontSize: 30, color: C.muted, marginTop: 8 }}>{sub}</div>
  </div>
);

const OneDatabase: React.FC<{ one: number; commit: number; noSync: number }> = ({ one, commit, noSync }) => {
  const frame = useCurrentFrame();
  const typical = interpolate(frame, [4, 18], [0, 1], clamp);
  const cross = interpolate(frame, [noSync - 2, noSync + 12], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const db = interpolate(frame, [one - 6, one + 8], [0, 1], clamp);
  const lines = [
    { t: 'BEGIN', tone: C.violet },
    { t: "INSERT INTO resolutions (…, outcome_rating, embedding, model_id)", tone: C.text },
    { t: "UPDATE disruption_cases SET status = 'resolved'", tone: C.text },
    { t: "UPDATE case_embeddings  SET case_status = 'resolved'", tone: C.text },
    { t: 'COMMIT', tone: C.violet },
  ];
  return (
    <AbsoluteFill style={{ padding: '150px 120px 190px', fontFamily: FONT }}>
      <Title text="State and memory, in one database" sub="written together, in a single SERIALIZABLE transaction" />
      <div style={{ display: 'flex', gap: 60, alignItems: 'stretch' }}>
        <div style={{ width: 560, position: 'relative', opacity: typical * (1 - cross * 0.45) }}>
          <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: 2, color: C.dim, marginBottom: 16 }}>THE USUAL SHAPE</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <MiniBox icon={<Database size={30} color={C.muted} />} t="Operational database" />
            <div style={{ textAlign: 'center', fontSize: 26, color: C.amber, fontWeight: 600 }}>⇅ sync job · drift window</div>
            <MiniBox icon={<Box size={30} color={C.muted} />} t="Separate vector database" />
          </div>
          <svg width={560} height={300} style={{ position: 'absolute', left: 0, top: 50 }}>
            <line x1={30} y1={30} x2={30 + 500 * cross} y2={30 + 240 * cross} stroke={C.red} strokeWidth={8} strokeLinecap="round" />
            <line x1={530} y1={30} x2={530 - 500 * cross} y2={30 + 240 * cross} stroke={C.red} strokeWidth={8} strokeLinecap="round" />
          </svg>
        </div>

        <div
          style={{
            flex: 1,
            opacity: db,
            translate: `${(1 - db) * 30}px 0`,
            padding: '26px 32px',
            borderRadius: 22,
            background: 'rgba(24,24,27,0.96)',
            border: `2px solid ${C.emerald}88`,
            boxShadow: `0 0 50px ${C.emerald}22`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <Database size={40} color={C.emerald} />
            <span style={{ fontSize: 38, fontWeight: 800, color: C.text }}>CockroachDB</span>
            <span style={{ marginLeft: 'auto', fontSize: 23, color: C.muted }}>rows + VECTOR(1024) side by side</span>
          </div>
          <div style={{ marginTop: 22, padding: '18px 22px', borderRadius: 14, background: '#050506', border: `1px solid ${C.surface2}` }}>
            {lines.map((l, i) => {
              const o = interpolate(frame, [commit - 10 + i * 5, commit - 2 + i * 5], [0, 1], clamp);
              return (
                <div key={i} style={{ fontFamily: MONO, fontSize: 26, lineHeight: 1.65, color: l.tone, opacity: o, paddingLeft: i === 0 || i === 4 ? 0 : 30, whiteSpace: 'pre' }}>
                  {l.t}
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 18, fontSize: 25, color: C.emerald, fontWeight: 600, opacity: cross }}>
            No gap between what the agent remembers and what happened.
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const MiniBox: React.FC<{ icon: React.ReactNode; t: string }> = ({ icon, t }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '24px 26px', borderRadius: 16, background: C.surface, border: `1px solid ${C.line}` }}>
    {icon}
    <span style={{ fontSize: 30, fontWeight: 600, color: C.text }}>{t}</span>
  </div>
);

const PrefixIndex: React.FC<{ start: number; inside: number }> = ({ start, inside }) => {
  const frame = useCurrentFrame();
  const beam = interpolate(frame, [start + 6, inside], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const hit = interpolate(frame, [inside - 4, inside + 8], [0, 1], clamp);
  const parts = [
    { k: "'open'", n: 2, on: false },
    { k: "'planned'", n: 2, on: false },
    { k: "'resolved'", n: 80, on: true },
  ];
  return (
    <AbsoluteFill style={{ padding: '150px 120px 190px', fontFamily: FONT }}>
      <Title text="The filter runs inside the vector index" sub="case_status is a prefix column: similarity and filtering in one indexed operation" />
      <div style={{ display: 'flex', gap: 50 }}>
        <div style={{ width: 760 }}>
          <div style={{ fontFamily: MONO, fontSize: 22, color: C.muted, marginBottom: 14 }}>VECTOR INDEX (case_status, embedding vector_cosine_ops)</div>
          <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {parts.map((p) => (
              <div
                key={p.k}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 18,
                  padding: '20px 24px',
                  borderRadius: 16,
                  background: p.on ? `rgba(52,211,153,${0.06 + 0.1 * hit})` : C.surface,
                  border: `2px solid ${p.on ? (hit > 0.5 ? C.emerald : C.line) : C.surface2}`,
                  opacity: p.on ? 1 : 1 - 0.55 * beam,
                }}
              >
                <span style={{ fontFamily: MONO, fontSize: 30, fontWeight: 700, color: p.on ? C.emerald : C.muted, width: 200 }}>{p.k}</span>
                <div style={{ flex: 1, display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {Array.from({ length: Math.min(p.n, 40) }, (_, i) => (
                    <span key={i} style={{ width: 14, height: 14, borderRadius: 4, background: p.on ? C.emerald : C.dim, opacity: 0.75 }} />
                  ))}
                </div>
                <span style={{ fontSize: 24, color: C.muted, width: 110, textAlign: 'right' }}>{p.n} cases</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 20, fontSize: 24, color: C.muted }}>
            Query vector goes straight to the <span style={{ color: C.emerald, fontWeight: 700 }}>resolved</span> partition: no ANN-then-filter.
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: 2, color: C.dim, marginBottom: 14 }}>EXPLAIN · THIS BUILD</div>
          <div style={{ padding: '22px 26px', borderRadius: 16, background: '#050506', border: `1px solid ${C.surface2}`, fontFamily: MONO, fontSize: 24, lineHeight: 1.75 }}>
            {EXPLAIN.map((l, i) => {
              const last = /prefix spans/.test(l);
              return (
                <div key={i} style={{ color: last ? C.emerald : C.text, fontWeight: last ? 700 : 400, background: last ? `rgba(52,211,153,${0.14 * hit})` : 'transparent', borderRadius: 8, padding: '0 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {i === 0 ? l : `  ${l}`}
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 16, fontSize: 21, color: C.dim }}>CockroachDB v26.2.1 · vector indexes are a Preview feature</div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const AwsShape: React.FC<{ start: number; bedrock: number; lambda: number; s3: number; zero: number }> = ({ start, bedrock, lambda, s3, zero }) => {
  const frame = useCurrentFrame();
  const on = (at: number) => interpolate(frame, [at - 4, at + 8], [0, 1], clamp);
  const flow = (frame - start) / 30;

  const nodes = [
    { id: 's3', x: 120, y: 470, icon: Globe, t: 'Amazon S3', s: 'static console', at: s3, tone: C.orange },
    { id: 'lambda', x: 690, y: 470, icon: Zap, t: 'AWS Lambda', s: 'Function URL · agent + API', at: lambda, tone: C.orange },
    { id: 'bedrock', x: 1260, y: 330, icon: Cpu, t: 'Amazon Bedrock', s: 'Titan Text Embeddings V2 · Nova Lite', at: bedrock, tone: C.violet },
    { id: 'crdb', x: 1260, y: 620, icon: Database, t: 'CockroachDB Cloud', s: 'rows + vectors · Managed MCP', at: start, tone: C.emerald },
  ];
  const links: [number, number][] = [
    [0, 1],
    [1, 2],
    [1, 3],
  ];
  const W = 540;
  const H = 130;

  return (
    <AbsoluteFill style={{ padding: '150px 120px 190px', fontFamily: FONT }}>
      <Title text="Built on AWS, idle costs nothing" sub="no API Gateway, no load balancer, no VPC" />
      <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
        {links.map(([a, b], i) => {
          const A = nodes[a];
          const B = nodes[b];
          const x1 = A.x + W;
          const y1 = A.y + H / 2;
          const x2 = B.x;
          const y2 = B.y + H / 2;
          const mx = (x1 + x2) / 2;
          const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
          return (
            <g key={i}>
              <path d={d} fill="none" stroke={C.line} strokeWidth={3} />
              <path d={d} fill="none" stroke={C.emerald} strokeWidth={3} strokeDasharray="10 26" strokeDashoffset={-flow * 60} opacity={0.8} />
            </g>
          );
        })}
      </svg>
      {nodes.map((n) => {
        const o = on(n.at);
        const Icon = n.icon;
        return (
          <div
            key={n.id}
            style={{
              position: 'absolute',
              left: n.x,
              top: n.y,
              width: W,
              height: H,
              display: 'flex',
              alignItems: 'center',
              gap: 20,
              padding: '0 26px',
              borderRadius: 20,
              background: 'rgba(24,24,27,0.97)',
              border: `2px solid ${o > 0.5 ? n.tone : C.surface2}`,
              boxShadow: o > 0.5 ? `0 0 40px ${n.tone}33` : 'none',
              opacity: 0.45 + 0.55 * o,
            }}
          >
            <span style={{ width: 70, height: 70, borderRadius: 18, background: `${n.tone}22`, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
              <Icon size={38} color={n.tone} />
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 34, fontWeight: 700, color: C.text }}>{n.t}</span>
              <span style={{ fontSize: 23, color: C.muted }}>{n.s}</span>
            </span>
          </div>
        );
      })}
      <div
        style={{
          position: 'absolute',
          left: 690,
          top: 660,
          width: W,
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '16px 22px',
          borderRadius: 16,
          border: `2px solid ${C.emerald}`,
          background: 'rgba(52,211,153,0.1)',
          opacity: on(zero),
          scale: String(0.94 + 0.06 * on(zero)),
        }}
      >
        <Cloud size={34} color={C.emerald} />
        <span style={{ fontSize: 30, fontWeight: 700, color: C.text }}>Scales to zero when idle</span>
      </div>
    </AbsoluteFill>
  );
};
