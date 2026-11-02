import { loadFont } from '@remotion/fonts';
import { staticFile } from 'remotion';

/**
 * The console's own identity: PrimeVue Aura's zinc surfaces, emerald primary
 * and the emerald-to-violet logo chip from web/app.css. Severity and outcome
 * colours match the console's score and severity classes.
 */
export const C = {
  bg: '#09090b',
  surface: '#18181b',
  surface2: '#27272a',
  line: '#3f3f46',
  text: '#fafafa',
  muted: '#a1a1aa',
  dim: '#71717a',
  emerald: '#34d399',
  emeraldDeep: '#10b981',
  violet: '#a78bfa',
  violetDeep: '#8b5cf6',
  amber: '#fbbf24',
  orange: '#fb923c',
  red: '#f87171',
  blue: '#60a5fa',
} as const;

export const LOGO_GRADIENT = `linear-gradient(135deg, ${C.emeraldDeep}, ${C.violetDeep})`;

// Self-hosted (public/fonts, SIL OFL) so rendering never depends on a font CDN.
export const FONT = 'Inter, "DejaVu Sans", sans-serif';
export const MONO = '"JetBrains Mono", "DejaVu Sans Mono", monospace';

for (const weight of ['400', '500', '600', '700', '800']) {
  loadFont({ family: 'Inter', url: staticFile(`fonts/inter-latin-${weight}-normal.woff2`), weight });
}
for (const weight of ['400', '500', '700']) {
  loadFont({ family: 'JetBrains Mono', url: staticFile(`fonts/jetbrains-mono-latin-${weight}-normal.woff2`), weight });
}
