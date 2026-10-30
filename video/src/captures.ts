import manifest from '../public/captures/manifest.json';

/**
 * The captured console states (video/capture/capture.cjs). Screenshots are
 * 3840x2160 renders of a 1440x810 CSS viewport; every box here is in those
 * CSS pixels, relative to the viewport at the moment the shot was taken.
 */

export type Rect = { x: number; y: number; w: number; h: number };

export const VIEW_W = manifest.viewport.width;
export const VIEW_H = manifest.viewport.height;

type Shots = typeof manifest.shots;
export type ShotName = keyof Shots;

export const shotSrc = (name: ShotName) => `captures/${name}.png`;

export function box<S extends ShotName>(shot: S, key: keyof Shots[S]['boxes']): Rect {
  return (manifest.shots[shot].boxes as Record<string, Rect>)[key as string];
}

/** A 16:9 camera view centred on a rect, zoomed so the rect fills `fill` of the frame. */
export function frameRect(r: Rect, fill = 0.8, offset: { dx?: number; dy?: number } = {}): Rect {
  const aspect = VIEW_W / VIEW_H;
  let w = r.w / fill;
  let h = r.h / fill;
  if (w / h > aspect) h = w / aspect;
  else w = h * aspect;
  w = Math.min(Math.max(w, VIEW_W / 2.6), VIEW_W);
  h = w / aspect;
  const cx = r.x + r.w / 2 + (offset.dx ?? 0);
  const cy = r.y + r.h / 2 + (offset.dy ?? 0);
  const x = Math.min(Math.max(cx - w / 2, 0), VIEW_W - w);
  const y = Math.min(Math.max(cy - h / 2, 0), VIEW_H - h);
  return { x, y, w, h };
}

export const FULL: Rect = { x: 0, y: 0, w: VIEW_W, h: VIEW_H };

export const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
