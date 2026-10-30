# Showcase video

The LinkedIn showcase for the IROPS Disruption Memory Agent: one 1920×1080
MP4, about 2:43, built with [Remotion](https://www.remotion.dev). This folder is
self-contained and does not touch the application.

## What is real

Every console screen is a screenshot of the **live demo**, driven end to end by
[`capture/capture.cjs`](capture/capture.cjs): the S3 frontend, the Lambda API,
Amazon Bedrock (Titan Text Embeddings V2 and Nova Lite) and CockroachDB Cloud
with its Managed MCP Server.

- The caseload is the demo dataset: `src/seed/` **as of commit 553f033**, seed
  `20260729`, then `npm run refresh:notes`. That is the only generator version
  that produces ZZ1137 (weather, 190′, 23 misconnecting). The generator after
  8bf8707 produces different flight numbers.
- The recording runs the agent on ZZ1137 (Nova Lite proposed 20 rebooks and a
  notification, citing ZZ4381 · 5/5), approves the plan, resolves the case and
  asks the analyst which cause had the worst average outcome. Its SQL and the
  rows it read are shown with the answer.
- The before/after list (`public/captures/data/neighbours.json`) is the
  resolved-only vector search for ZZ4381, run read-only through the Managed
  MCP Server before and after ZZ1137 was resolved.
- The EXPLAIN excerpt (`src/data/explain.json`) is `scripts/verify-schema.mjs`
  output from the live cluster.

The capture writes to the live demo. Re-seed afterwards so ZZ1137 is open again.

## Layout

| Path | What |
| --- | --- |
| `capture/capture.cjs` | Playwright run over the live console: element boxes, API JSON, MCP queries |
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
standalone file. It is slowed about 6% so its ending lands on the end card:

```bash
ffmpeg -i motivational-day-112790.mp3 -filter:a atempo=0.9417 -c:a libmp3lame -b:a 192k public/music.mp3
```

Re-capture (from the repo root, after `npm run build`; `MCP_API_KEY` and
`MCP_CLUSTER_ID` in `.env`):

```bash
NODE_USE_ENV_PROXY=1 node --env-file=.env video/capture/capture.cjs
```

Narration, only if the script changes (`ELEVENLABS_API_KEY`; voice
"Hale", `dXtC3XhB9GtPusIpNtQx`; existing takes are reused unless `--force`).
Each take is paced toward 147 wpm, cleared of anything after the voice has
decayed and levelled to −19 LUFS; the header of `voiceover/generate.mjs` has
the details:

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
download its own. The delivered file converts to standard-range `yuv420p` and
normalises audio to −14 LUFS:

```bash
ffmpeg -i out/irops-showcase-raw.mp4 -vf "scale=in_range=full:out_range=tv,format=yuv420p" -c:v libx264 -preset slow -crf 16 -af loudnorm=I=-14:TP=-1.5:LRA=11 -c:a aac -b:a 256k -movflags +faststart out/irops-showcase.mp4
```
