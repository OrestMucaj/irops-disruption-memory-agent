/**
 * Generates the narration with ElevenLabs, one file per script section, and
 * records word-level timings for the captions and scene cues.
 *
 *     NODE_USE_ENV_PROXY=1 node voiceover/generate.mjs            # all missing sections
 *     NODE_USE_ENV_PROXY=1 node voiceover/generate.mjs --only s04-console,s11-close --force
 *     NODE_USE_ENV_PROXY=1 node voiceover/generate.mjs --test "Text to audition" out.mp3
 *
 * Uses the /with-timestamps endpoint, which returns character-level alignment
 * for the exact audio produced. That replaces a Whisper pass: the timings are
 * the synthesiser's own, not a transcription's estimate.
 *
 * Captions show the script as written ("ZZ1137", "CockroachDB"); the voice is
 * sent a phonetic spelling ("Z-Z eleven thirty-seven", "Cockroach D-B"). The
 * spoken words are mapped back onto the written ones so each caption word
 * carries the timing of the sounds that say it.
 *
 * Raw takes are kept in voiceover/raw/. The files the video plays are those
 * takes time-stretched with ffmpeg's pitch-preserving atempo toward
 * TARGET_WPM (never beyond MAX_TEMPO), with the word timings scaled to match.
 *
 * Each processed take is also cleaned and levelled:
 *  - everything after the voice has decayed is faded to silence. ElevenLabs
 *    sometimes starts on the next text at the very end of a take, a short
 *    burst after the silence; the file keeps its length, so no timing moves;
 *  - 10 ms fades at both ends, so no take starts or stops with a click;
 *  - levelled to TARGET_LUFS with a peak limiter, so takes match each other.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = JSON.parse(readFileSync(join(ROOT, 'voiceover/script.json'), 'utf8'));
const RAW_DIR = join(ROOT, 'voiceover/raw');
const AUDIO_DIR = join(ROOT, 'public/voiceover');
const ALIGN_DIR = join(ROOT, 'voiceover/alignment');

/** Target speaking rate. Hale's natural read is ~130 wpm; ~147 suits a feed. */
const TARGET_WPM = 147;
const MAX_TEMPO = 1.1;
const TARGET_LUFS = -19;
const OUT_JSON = join(ROOT, 'src/data/voiceover.json');

const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error('ELEVENLABS_API_KEY is not set');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};

/** Applies the pronunciation table to one token's core, keeping punctuation. */
function speakToken(token) {
  const m = /^([^A-Za-z0-9]*)(.*?)([^A-Za-z0-9']*)$/.exec(token);
  const [, pre, core, post] = m;
  for (const [written, spoken] of script.pronunciations) {
    if (core === written) return `${pre}${spoken}${post}`;
  }
  return token;
}

const toSpoken = (text) => text.split(/\s+/).map(speakToken).join(' ');

async function tts(text, previousText, nextText, speed) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${script.voiceId}/with-timestamps?output_format=mp3_44100_128`;
  const body = {
    text,
    model_id: script.model,
    voice_settings: { ...script.settings, ...(speed ? { speed } : {}) },
    ...(previousText ? { previous_text: previousText } : {}),
    ...(nextText ? { next_text: nextText } : {}),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Spoken words with start/end seconds, from character alignment.
 *
 * `end` is where the word's last letter ends. A trailing full stop's
 * alignment spans the pause after it, which would hold captions and the
 * music duck too long; `endAny` keeps that span for the pacing calculation.
 */
function spokenWords(alignment) {
  const chars = alignment.characters;
  const starts = alignment.character_start_times_seconds;
  const ends = alignment.character_end_times_seconds;
  const words = [];
  let current = null;
  for (let i = 0; i < chars.length; i += 1) {
    if (/\s/.test(chars[i])) {
      if (current) words.push(current);
      current = null;
      continue;
    }
    if (!current) current = { text: '', start: starts[i], end: ends[i], endAny: ends[i] };
    current.text += chars[i];
    current.endAny = ends[i];
    if (/[A-Za-z0-9]/.test(chars[i])) current.end = ends[i];
  }
  if (current) words.push(current);
  return words;
}

/** Maps spoken words back onto the written tokens. */
function displayWords(text, spoken) {
  const out = [];
  let k = 0;
  for (const token of text.split(/\s+/)) {
    const n = speakToken(token).split(/\s+/).length;
    const span = spoken.slice(k, k + n);
    if (span.length !== n) throw new Error(`alignment ran out at "${token}"`);
    out.push({ text: token, start: span[0].start, end: span[n - 1].end, endAny: span[n - 1].endAny });
    k += n;
  }
  if (k !== spoken.length) throw new Error(`${spoken.length - k} spoken words left unmapped`);
  return out;
}

const audioSeconds = (file) =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());

/** Mono samples of a file, for finding where the voice stops. */
function samples(file, sr = 16000) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(sr), '-'], { maxBuffer: 1 << 28 });
  return { x: new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4), sr };
}

/** First point after `from` where the next 30 ms all sit below -50 dBFS. */
function decayEnd({ x, sr }, from, cap) {
  const win = Math.round(sr * 0.01);
  const db = (i) => {
    let sum = 0;
    for (let k = i; k < i + win && k < x.length; k += 1) sum += x[k] * x[k];
    return 10 * Math.log10(sum / win + 1e-12);
  };
  for (let t = from; t < cap; t += 0.01) {
    const i = Math.round(t * sr);
    if (db(i) < -50 && db(i + win) < -50 && db(i + 2 * win) < -50) return t;
  }
  return cap;
}

/** Integrated loudness of a file, in LUFS. */
function loudness(file) {
  const err = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const m = /I:\s+(-?[\d.]+) LUFS/.exec(err.slice(err.lastIndexOf('Summary')));
  if (!m) throw new Error(`could not measure loudness of ${file}`);
  return Number(m[1]);
}

// --- audition ---------------------------------------------------------------
if (flag('--test')) {
  const text = opt('--test');
  const out = args[args.indexOf('--test') + 2] ?? 'test.mp3';
  const r = await tts(toSpoken(text));
  writeFileSync(out, Buffer.from(r.audio_base64, 'base64'));
  console.log('wrote', out, '-', toSpoken(text));
  process.exit(0);
}

// --- full generation --------------------------------------------------------
mkdirSync(RAW_DIR, { recursive: true });
mkdirSync(AUDIO_DIR, { recursive: true });
mkdirSync(ALIGN_DIR, { recursive: true });
mkdirSync(dirname(OUT_JSON), { recursive: true });

const only = opt('--only')?.split(',') ?? null;
const force = flag('--force');
const sections = script.sections;

for (const [i, s] of sections.entries()) {
  const audio = join(RAW_DIR, `${s.id}.mp3`);
  const align = join(ALIGN_DIR, `${s.id}.json`);
  const wanted = only ? only.includes(s.id) : true;
  if (!wanted || (!force && existsSync(audio) && existsSync(align))) continue;

  const spoken = toSpoken(s.text);
  const prev = i > 0 ? toSpoken(sections[i - 1].text) : undefined;
  const next = i < sections.length - 1 ? toSpoken(sections[i + 1].text) : undefined;
  const r = await tts(spoken, prev, next, s.speed);
  writeFileSync(audio, Buffer.from(r.audio_base64, 'base64'));
  writeFileSync(align, JSON.stringify({ spoken, alignment: r.alignment }, null, 1));
  console.log(`generated ${s.id} (${spoken.length} chars)`);
}

const combined = sections.map((s) => {
  const raw = join(RAW_DIR, `${s.id}.mp3`);
  const audio = join(AUDIO_DIR, `${s.id}.mp3`);
  const align = join(ALIGN_DIR, `${s.id}.json`);
  if (!existsSync(raw) || !existsSync(align)) return null;
  const { alignment } = JSON.parse(readFileSync(align, 'utf8'));
  const rawWords = displayWords(s.text, spokenWords(alignment));
  const rawSpeech = rawWords[rawWords.length - 1].endAny - rawWords[0].start;
  const wpm = (rawWords.length / rawSpeech) * 60;
  const tempo = Math.round(Math.min(MAX_TEMPO, Math.max(1, TARGET_WPM / wpm)) * 100) / 100;

  // Silence anything after the voice has decayed, in the stretched timeline.
  const lastLetter = rawWords[rawWords.length - 1].end;
  const silentFrom = (decayEnd(samples(raw), lastLetter, lastLetter + 0.45) + 0.04) / tempo;
  const shaped = join(ALIGN_DIR, `${s.id}.shaped.wav`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-af',
    `atempo=${tempo},afade=t=in:st=0:d=0.01,afade=t=out:st=${silentFrom.toFixed(3)}:d=0.04`, shaped]);
  const gain = TARGET_LUFS - loudness(shaped);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', shaped, '-af',
    `volume=${gain.toFixed(2)}dB,alimiter=limit=0.84:level=0:latency=1`, '-c:a', 'libmp3lame', '-b:a', '192k', audio]);
  rmSync(shaped);
  const words = rawWords.map(({ endAny: _endAny, ...w }) => ({ ...w, start: w.start / tempo, end: w.end / tempo }));
  return {
    id: s.id,
    scene: s.scene,
    text: s.text,
    file: `voiceover/${s.id}.mp3`,
    tempo,
    speechStart: words[0].start,
    speechEnd: words[words.length - 1].end,
    audioDuration: audioSeconds(audio),
    words,
  };
});

if (combined.every(Boolean)) {
  writeFileSync(OUT_JSON, JSON.stringify(combined, null, 1));
  const total = combined.reduce((t, s) => t + s.audioDuration, 0);
  console.log(`wrote ${OUT_JSON}: ${combined.length} sections, ${total.toFixed(1)}s of audio`);
} else {
  console.log('some sections missing; src/data/voiceover.json not written');
}
