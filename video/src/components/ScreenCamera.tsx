import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

import { FULL, Rect, ShotName, VIEW_W, shotSrc } from '../captures';
import { C, FONT } from '../theme';

/**
 * A virtual camera over the real console captures.
 *
 * Shots crossfade at their `from` frame. The camera eases between views,
 * interpolating the centre linearly and the zoom logarithmically so pushes in
 * and out feel even. Images are laid out at their final on-screen size (not
 * CSS-scaled) so Chrome resamples the 4K source rather than upscaling a 1080p
 * raster — zoomed UI stays sharp.
 */

export type ShotKey = { from: number; shot: ShotName; fade?: number };
export type CamKey = { at: number; view: Rect; dur?: number };
export type CursorKey = { at: number; x: number; y: number; dur?: number; click?: boolean };
export type Spot = {
  from: number;
  to: number;
  rect: Rect;
  label?: string;
  sub?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  tone?: string;
  pad?: number;
  dim?: number;
  /** Nudges the label vertically, in output pixels (e.g. clear of lifted captions). */
  labelDy?: number;
};

const EASE = Easing.bezier(0.65, 0, 0.35, 1);

function viewAt(frame: number, keys: CamKey[]): Rect {
  let v = keys[0]?.view ?? FULL;
  for (let i = 1; i < keys.length; i += 1) {
    const k = keys[i];
    const dur = k.dur ?? 26;
    if (frame <= k.at) break;
    const t = EASE(Math.min(1, (frame - k.at) / dur));
    const a = v;
    const b = k.view;
    const za = Math.log(a.w);
    const zb = Math.log(b.w);
    const w = Math.exp(za + (zb - za) * t);
    const acx = a.x + a.w / 2;
    const acy = a.y + a.h / 2;
    const bcx = b.x + b.w / 2;
    const bcy = b.y + b.h / 2;
    const cx = acx + (bcx - acx) * t;
    const cy = acy + (bcy - acy) * t;
    const h = (w * a.h) / a.w;
    v = { x: cx - w / 2, y: cy - h / 2, w, h };
  }
  return v;
}

export function useCameraView(keys: CamKey[]) {
  const frame = useCurrentFrame();
  return viewAt(frame, keys);
}

/** CSS-space rect to output pixels under a view. */
export function project(r: Rect, view: Rect, outW: number) {
  const s = outW / view.w;
  return { x: (r.x - view.x) * s, y: (r.y - view.y) * s, w: r.w * s, h: r.h * s };
}

export const ScreenCamera: React.FC<{
  shots: ShotKey[];
  cams: CamKey[];
  /** Cursor passes, each visible between its own from and to. */
  cursors?: { keys: CursorKey[]; from: number; to: number }[];
  spots?: Spot[];
  children?: React.ReactNode;
}> = ({ shots, cams, cursors = [], spots = [], children }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const view = viewAt(frame, cams);
  const s = width / view.w;
  const imgW = VIEW_W * s;
  const imgH = (VIEW_W * s * height) / width;

  // A shot shows from its start until the next one has fully faded in over it.
  const layers = shots.filter((k, i) => {
    const next = shots[i + 1];
    const covered = next !== undefined && frame >= next.from + (next.fade ?? 8);
    return (i === 0 || frame >= k.from) && !covered;
  });

  return (
    <AbsoluteFill style={{ overflow: 'hidden', backgroundColor: C.bg }}>
      {layers.map((k) => (
        <Img
          key={`${k.shot}-${k.from}`}
          src={staticFile(shotSrc(k.shot))}
          style={{
            position: 'absolute',
            left: -view.x * s,
            top: -view.y * s,
            width: imgW,
            height: imgH,
            maxWidth: 'none',
            opacity: k === shots[0] ? 1 : interpolate(frame, [k.from, k.from + (k.fade ?? 8)], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          }}
        />
      ))}
      {spots.map((sp, i) => (
        <SpotLayer key={i} spot={sp} view={view} />
      ))}
      {children}
      {cursors.map((c, i) => (
        <CursorLayer key={i} keys={c.keys} view={view} from={c.from} to={c.to} />
      ))}
    </AbsoluteFill>
  );
};

const SpotLayer: React.FC<{ spot: Spot; view: Rect }> = ({ spot, view }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  if (frame < spot.from - 2 || frame > spot.to + 12) return null;
  const pad = spot.pad ?? 8;
  const r = project({ x: spot.rect.x - pad, y: spot.rect.y - pad, w: spot.rect.w + 2 * pad, h: spot.rect.h + 2 * pad }, view, width);
  const o = interpolate(frame, [spot.from, spot.from + 10, spot.to, spot.to + 10], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const tone = spot.tone ?? C.emerald;
  const grow = interpolate(frame, [spot.from, spot.from + 14], [10, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  const side = spot.side ?? (r.y + r.h / 2 > height * 0.55 ? 'top' : 'bottom');

  // Labels hug the rect's left edge but never leave the frame. A label on the
  // left is anchored by its right edge, so it has the whole width to lay out in.
  const labelX = Math.max(60, Math.min(r.x, width - 820));
  const dy = spot.labelDy ?? 0;
  const labelStyle: React.CSSProperties = { position: 'absolute' };
  if (side === 'bottom') Object.assign(labelStyle, { left: labelX, top: r.y + r.h + 22 + dy });
  if (side === 'top') Object.assign(labelStyle, { left: labelX, top: r.y - 22 + dy, translate: '0 -100%' });
  if (side === 'right') Object.assign(labelStyle, { left: r.x + r.w + 26, top: r.y + r.h / 2 + dy, translate: '0 -50%' });
  if (side === 'left') Object.assign(labelStyle, { right: width - (r.x - 26), top: r.y + r.h / 2 + dy, translate: '0 -50%' });

  return (
    <AbsoluteFill style={{ opacity: o }}>
      <div
        style={{
          position: 'absolute',
          left: r.x - grow,
          top: r.y - grow,
          width: r.w + 2 * grow,
          height: r.h + 2 * grow,
          borderRadius: 14,
          boxShadow: `0 0 0 4000px rgba(5,5,7,${spot.dim ?? 0.58}), 0 0 0 3px ${tone}, 0 0 38px 6px ${tone}55`,
        }}
      />
      {spot.label && (
        <div style={{ ...labelStyle, maxWidth: Math.min(760, width - 120) }}>
          <Callout label={spot.label} sub={spot.sub} tone={tone} />
        </div>
      )}
    </AbsoluteFill>
  );
};

export const Callout: React.FC<{ label: string; sub?: string; tone?: string }> = ({ label, sub, tone = C.emerald }) => (
  <div
    style={{
      display: 'inline-flex',
      flexDirection: 'column',
      gap: 6,
      padding: '16px 24px 16px 22px',
      borderRadius: 14,
      background: 'rgba(14,14,17,0.92)',
      border: `1px solid ${C.line}`,
      borderLeft: `5px solid ${tone}`,
      boxShadow: '0 18px 50px rgba(0,0,0,0.55)',
      fontFamily: FONT,
    }}
  >
    <span style={{ fontSize: 36, fontWeight: 700, color: C.text, letterSpacing: -0.4, lineHeight: 1.15, textWrap: 'balance' }}>{label}</span>
    {sub && <span style={{ fontSize: 25, fontWeight: 500, color: C.muted, lineHeight: 1.3, textWrap: 'balance' }}>{sub}</span>}
  </div>
);

const CursorLayer: React.FC<{ keys: CursorKey[]; view: Rect; from: number; to: number }> = ({ keys, view, from, to }) => {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  if (frame < from || frame > to + 8) return null;

  let x = keys[0].x;
  let y = keys[0].y;
  for (let i = 1; i < keys.length; i += 1) {
    const k = keys[i];
    const dur = k.dur ?? 20;
    const startAt = k.at - dur;
    if (frame <= startAt) break;
    const t = EASE(Math.min(1, (frame - startAt) / dur));
    x += (k.x - x) * t;
    y += (k.y - y) * t;
  }
  const p = project({ x, y, w: 0, h: 0 }, view, width);

  const clicks = keys.filter((k) => k.click && frame >= k.at - 3 && frame < k.at + 18);
  const press = keys.some((k) => k.click && frame >= k.at - 2 && frame < k.at + 3);
  const fade = interpolate(frame, [from, from + 8, to, to + 8], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ opacity: fade, pointerEvents: 'none' }}>
      {clicks.map((k, i) => {
        const t = (frame - k.at) / 18;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: p.x,
              top: p.y,
              width: 90,
              height: 90,
              marginLeft: -45,
              marginTop: -45,
              borderRadius: '50%',
              border: `3px solid ${C.emerald}`,
              opacity: Math.max(0, 0.9 - Math.max(0, t) * 0.9),
              scale: String(0.3 + Math.max(0, t) * 0.9),
            }}
          />
        );
      })}
      <svg
        width={40}
        height={48}
        viewBox="0 0 20 24"
        style={{ position: 'absolute', left: p.x - 3, top: p.y - 2, scale: press ? '0.86' : '1', transformOrigin: '3px 2px', filter: 'drop-shadow(0 4px 8px rgba(0,0,0,0.5))' }}
      >
        <path d="M2 1.5 L2 19 L6.6 14.8 L9.6 21.6 L12.6 20.3 L9.7 13.6 L16 13.4 Z" fill="#fff" stroke="#111" strokeWidth={1.3} strokeLinejoin="round" />
      </svg>
    </AbsoluteFill>
  );
};
