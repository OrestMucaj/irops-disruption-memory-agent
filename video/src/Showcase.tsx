import React from 'react';
import { AbsoluteFill, interpolate, Sequence, staticFile, useCurrentFrame } from 'remotion';
import { Audio } from '@remotion/media';

import { Captions } from './components/Captions';
import { SceneFade } from './components/Chrome';
import { AnalystScene } from './scenes/AnalystScene';
import { CloseScene } from './scenes/CloseScene';
import { DemoScene } from './scenes/DemoScene';
import { EngineeringScene } from './scenes/EngineeringScene';
import { HookScene } from './scenes/HookScene';
import { IntroScene } from './scenes/IntroScene';
import { LoopScene } from './scenes/LoopScene';
import { f, FPS, scenes, sections, TOTAL_FRAMES } from './timeline';
import { C } from './theme';

/**
 * IROPS Disruption Memory Agent — LinkedIn showcase, 1920x1080.
 *
 * Scenes are placed on the narration's timeline (timeline.ts) and crossfade
 * over each other at the boundaries. Captions, narration, music and effects
 * sit above and below them on the same clock.
 */
export const Showcase: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: C.bg }}>
    <Sequence name="Hook" from={scenes.hook.from} durationInFrames={scenes.hook.duration}>
      <SceneFade fadeIn={0}>
        <HookScene />
      </SceneFade>
    </Sequence>
    <Sequence name="Intro" from={scenes.intro.from} durationInFrames={scenes.intro.duration}>
      <SceneFade>
        <IntroScene />
      </SceneFade>
    </Sequence>
    <Sequence name="Product walkthrough" from={scenes.demo.from} durationInFrames={scenes.demo.duration}>
      <SceneFade>
        <DemoScene />
      </SceneFade>
    </Sequence>
    <Sequence name="Memory loop" from={scenes.loop.from} durationInFrames={scenes.loop.duration}>
      <SceneFade>
        <LoopScene />
      </SceneFade>
    </Sequence>
    <Sequence name="Ask the memory" from={scenes.analyst.from} durationInFrames={scenes.analyst.duration}>
      <SceneFade>
        <AnalystScene />
      </SceneFade>
    </Sequence>
    <Sequence name="Under the hood" from={scenes.engineering.from} durationInFrames={scenes.engineering.duration}>
      <SceneFade>
        <EngineeringScene />
      </SceneFade>
    </Sequence>
    <Sequence name="Close" from={scenes.close.from} durationInFrames={scenes.close.duration}>
      <SceneFade fadeOut={0}>
        <CloseScene />
      </SceneFade>
    </Sequence>

    <Captions />

    {sections.map((s) => (
      <Sequence key={s.id} name={`VO ${s.id}`} from={f(s.at)} durationInFrames={Math.ceil(s.audioDuration * FPS) + 2}>
        <Audio src={staticFile(s.file)} volume={1} />
      </Sequence>
    ))}

    <Music />

    <Sequence name="Flaps" from={2} durationInFrames={60}>
      <Audio src={staticFile('sfx/flaps.wav')} volume={0.3} />
    </Sequence>
    {(['intro', 'demo', 'loop', 'analyst', 'engineering', 'close'] as const).map((id) => (
      <Sequence key={id} name={`Whoosh ${id}`} from={scenes[id].from - 4} durationInFrames={28}>
        <Audio src={staticFile('sfx/whoosh.wav')} volume={0.16} />
      </Sequence>
    ))}
  </AbsoluteFill>
);

/** Music bed, ducked under the narration with short ramps either side of each line. */
const Music: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  let duck = 0;
  for (const s of sections) {
    const a = s.at + s.speechStart;
    const b = s.at + s.speechEnd;
    duck = Math.max(duck, interpolate(t, [a - 0.3, a, b, b + 0.45], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
  }
  const ends = interpolate(frame, [0, 6, TOTAL_FRAMES - 75, TOTAL_FRAMES - 4], [0.6, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <Audio src={staticFile('music.mp3')} volume={(0.26 - 0.15 * duck) * ends} />;
};
