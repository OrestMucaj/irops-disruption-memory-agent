# Showcase video

The LinkedIn showcase for the IROPS Disruption Memory Agent: one 1920×1080
MP4, about 2:34, built with [Remotion](https://www.remotion.dev). This folder is
self-contained and does not touch the application.

## What is real

Every console screen is a screenshot of the actual app (`web/` + `src/api/`),
driven end to end by [`capture/capture.cjs`](capture/capture.cjs) against a
**local** build:

- CockroachDB v26.2.1 single node, `migrations/` applied as-is.
- The demo dataset: `src/seed/` **as of commit 553f033**, seed `20260729`, then
  `npm run refresh:notes`. That reproduces the live demo's caseload exactly
  (ZZ1137: weather, 190′, 23 misconnecting). The generator after 8bf8707
  produces different flight numbers.
- `EMBEDDING_PROVIDER=fake`, `LLM_PROVIDER=heuristic`. The deployed demo's
  CockroachDB cluster no longer exists and no Bedrock credentials were
  available, so the recording uses the offline stand-ins. The video says so on
  screen and in the narration. It never presents the stand-in's plan as Nova
  Lite's.
- The MCP analyst needs CockroachDB Cloud's Managed MCP Server, so it is shown
  as UI plus the real `scripts/analyst-guardrails.mjs` result, with no answer.

The EXPLAIN excerpt (`src/data/explain.json`) and the before/after retrieval
lists (`public/captures/data/neighbours-*.json`) are output from that same
local build.

## Layout

| Path | What |
| --- | --- |
| `capture/capture.cjs` | Playwright run over the console: 21 states, element boxes, API JSON |
| `public/captures/` | 3840×2160 screenshots (1440×810 CSS at DPR 8/3), `manifest.json`, data |
| `voiceover/script.json` | Narration, per-section pacing, pronunciation respellings |
| `voiceover/generate.mjs` | ElevenLabs TTS with timestamps → `public/voiceover/`, `src/data/voiceover.json` |
| `src/timeline.ts` | Every scene, cue and caption is timed from the narration |
| `src/scenes/` | Hook, intro, walkthrough, memory loop, analyst, engineering, close |
| `src/components/ScreenCamera.tsx` | Camera, cursor and spotlights over the captures |
| `public/sfx/` | Clicks, flaps, whoosh, confirm: synthesised with ffmpeg/numpy |
| `public/fonts/` | Inter and JetBrains Mono (SIL OFL), self-hosted |

## Rebuild

```bash
npm install
```

The music bed is **Motivational Day** (Pixabay, royalty-free). It is not
committed, because the Pixabay licence doesn't allow redistributing the
standalone file. Put it at `public/music.mp3`.

Narration, only if the script changes (`ELEVENLABS_API_KEY`; voice
"Hale", `dXtC3XhB9GtPusIpNtQx`; existing takes are reused unless `--force`):

```bash
NODE_USE_ENV_PROXY=1 node voiceover/generate.mjs
```

Preview and render:

```bash
npx remotion studio
```

```bash
npx remotion render IROPS-Showcase out/irops-showcase-raw.mp4 --codec=h264 --crf=17 --jpeg-quality=95
```

Set `REMOTION_BROWSER` to a Chrome Headless Shell binary if Remotion can't
download its own. The delivered file is the render with its audio normalised to
−14 LUFS:

```bash
ffmpeg -i out/irops-showcase-raw.mp4 -c:v copy -af loudnorm=I=-14:TP=-1.5:LRA=11 -c:a aac -b:a 256k -movflags +faststart out/irops-showcase.mp4
```
