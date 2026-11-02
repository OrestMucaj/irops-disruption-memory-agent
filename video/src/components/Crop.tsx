import React from 'react';
import { Img, staticFile } from 'remotion';

import { Rect, ShotName, VIEW_H, VIEW_W, shotSrc } from '../captures';
import { C } from '../theme';

/** A region of a captured console state, shown at a given on-screen width. */
export const Crop: React.FC<{ shot: ShotName; rect: Rect; width: number; style?: React.CSSProperties }> = ({ shot, rect, width, style }) => {
  const s = width / rect.w;
  return (
    <div
      style={{
        width,
        height: rect.h * s,
        overflow: 'hidden',
        position: 'relative',
        borderRadius: 18,
        border: `1px solid ${C.line}`,
        boxShadow: '0 40px 100px rgba(0,0,0,0.65)',
        ...style,
      }}
    >
      <Img
        src={staticFile(shotSrc(shot))}
        style={{ position: 'absolute', left: -rect.x * s, top: -rect.y * s, width: VIEW_W * s, height: VIEW_H * s, maxWidth: 'none' }}
      />
    </div>
  );
};
