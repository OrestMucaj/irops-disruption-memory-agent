/**
 * Renders review stills at the given times (seconds) from one bundle.
 *
 *     REMOTION_BROWSER=/path/to/chrome-headless-shell node scripts/stills.mjs 1.5 12 40.2
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'out/stills');
mkdirSync(OUT, { recursive: true });

const times = process.argv.slice(2).map(Number);
const serveUrl = await bundle({ entryPoint: join(ROOT, 'src/index.ts') });
const browserExecutable = process.env.REMOTION_BROWSER ?? null;
const composition = await selectComposition({ serveUrl, id: 'IROPS-Showcase', browserExecutable });

for (const t of times) {
  const frame = Math.min(composition.durationInFrames - 1, Math.round(t * composition.fps));
  const output = join(OUT, `t${t.toFixed(1).padStart(5, '0')}.png`);
  await renderStill({ serveUrl, composition, frame, output, browserExecutable });
  console.log(output);
}
