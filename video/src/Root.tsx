import React from 'react';
import { Composition } from 'remotion';

import { Showcase } from './Showcase';
import { FPS, TOTAL_FRAMES } from './timeline';

export const RemotionRoot: React.FC = () => (
  <Composition id="IROPS-Showcase" component={Showcase} durationInFrames={TOTAL_FRAMES} fps={FPS} width={1920} height={1080} />
);
