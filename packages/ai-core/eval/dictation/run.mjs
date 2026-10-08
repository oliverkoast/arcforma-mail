#!/usr/bin/env node
/**
 * Dictation eval: OpenWhispr's real recordings through the speech models, then
 * the cleanup pass, scored for accuracy and timed.
 *
 *   node eval/dictation/run.mjs --draft      transcribe every clip with Parakeet and Whisper and
 *                                            write references.draft.json for a person to correct
 *   node eval/dictation/run.mjs              score against references.json
 *        [--asr parakeet,whisper] [--cleanup local:<prompt>,claude:<model>:<prompt>,none]
 *
 * Audio and transcripts are the person's own and never enter the repository. Clips are read
 * where OpenWhispr keeps them (~/Library/Application Support/open-whispr/audio, named
 * OpenWhispr-<date>-<id>.webm); references live beside the eval data in
 * ~/Library/Application Support/Arcforma/evals/dictation/references.json:
 *   { "<id>": { "reference": "what was said, word for word", "clean": "what should be pasted" } }
 *
 * Parakeet runs the way OpenWhispr runs it: sherpa-onnx's offline WebSocket server on the
 * parakeet-tdt-0.6b-v3 int8 model, 16 kHz float32 samples. Whisper is whisper-cli with
 * large-v3-turbo, as a second opinion. The cleanup prompt defaults to the one staged at
 * ~/Documents/openwhispr-config/cleanup-prompt-oliver.txt.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalModel } from "../../src/local.mjs";
import { ClaudeRunner } from "../../src/claude.mjs";
import { parsePrompt, loadPrompt } from "../../src/prompts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const AUDIO = process.env.ARCFORMA_DICTATION_AUDIO ?? path.join(HOME, "Library", "Application Support", "open-whispr", "audio");
const DATA = process.env.ARCFORMA_DICTATION_DATA ?? path.join(HOME, "Library", "Application Support", "Arcforma", "evals", "dictation");
const OW_BIN = path.join(HOME, "Projects", "openwhispr", "resources", "bin");
const PARAKEET = path.join(HOME, ".cache", "openwhispr", "parakeet-models", "parakeet-tdt-0.6b-v3");
const WHISPER_MODEL = path.join(HOME, ".cache", "whisper-cpp", "ggml-large-v3-turbo.bin");
const CLEANUP_PROMPT = path.join(HOME, "Documents", "openwhispr-config", "cleanup-prompt-oliver.txt");
/** Words the speaker uses that a speech model is likely to get wrong. Scored on their own. */
const TERMS = ["Arcforma", "Granola", "Notion", "Mercury", "Render", "Clerk", "Postmark", "Qdrant", "Parakeet", "OpenWhispr", "Claude", "ChatGPT", "Maya", "Oliver", "Codex", "Cmd+J"];

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);

function clips() {
  return fs
    .readdirSync(AUDIO)
    .filter((f) => /\.(webm|wav|m4a|ogg)$/.test(f))
    .map((f) => ({ id: /-(\d+)\.\w+$/.exec(f)?.[1] ?? f, file: path.join(AUDIO, f) }))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

/** 16 kHz mono float32, the samples OpenWhispr sends. */
function samples(file) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
  return r.stdout;
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function parakeetServer() {
  const port = await freePort();
  const bin = path.join(OW_BIN, "sherpa-onnx-ws-darwin-arm64");
  const threads = Math.max(1, Math.min(4, Math.floor(os.cpus().length * 0.75)));
  const child = spawn(bin, [`--tokens=${PARAKEET}/tokens.txt`, `--encoder=${PARAKEET}/encoder.int8.onnx`, `--decoder=${PARAKEET}/decoder.int8.onnx`, `--joiner=${PARAKEET}/joiner.int8.onnx`, `--port=${port}`, `--num-threads=${threads}`], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: os.tmpdir(),
    env: { ...process.env, DYLD_LIBRARY_PATH: OW_BIN },
  });
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    const up = await new Promise((r) => {
      const s = net.connect(port, "127.0.0.1", () => (s.end(), r(true)));
      s.on("error", () => r(false));
    });
    if (up) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const transcribe = (buf) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.binaryType = "arraybuffer";
      let result = "";
      ws.onopen = () => {
        const msg = Buffer.alloc(8 + buf.length);
        msg.writeInt32LE(16000, 0);
        msg.writeInt32LE(buf.length, 4);
        buf.copy(msg, 8);
        ws.send(msg);
      };
      ws.onmessage = (e) => {
        result += typeof e.data === "string" ? e.data : Buffer.from(e.data).toString();
        ws.send("Done");
      };
      ws.onclose = () => {
        try {
          const j = JSON.parse(result);
          resolve(String(j.text ?? result).trim());
        } catch {
          resolve(result.trim());
        }
      };
      ws.onerror = (e) => reject(new Error(String(e.message ?? "ws error")));
    });
  // One warm-up so the first clip does not pay the model load.
  await transcribe(Buffer.alloc(16000 * 4));
  return { transcribe, stop: () => child.kill("SIGTERM") };
}

function whisper(file) {
  const wav = path.join(os.tmpdir(), `arcforma-eval-${process.pid}.wav`);
  spawnSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-ac", "1", "-ar", "16000", wav]);
  const r = spawnSync("whisper-cli", ["-m", WHISPER_MODEL, "-f", wav, "-nt", "-np", "-l", "en"], { encoding: "utf8", maxBuffer: 1 << 24 });
  fs.rmSync(wav, { force: true });
  return r.stdout.replace(/\s+/g, " ").trim();
}

// ---- scoring ----------------------------------------------------------------------------------

const NUM = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
/** Hesitation sounds. A speech model is not scored on keeping or dropping them; the cleanup pass is. */
const HESITATIONS = new Set(["um", "umm", "uh", "uhh", "er", "ah", "hmm", "mm"]);
/** Lowercase words without punctuation or hesitations, small number words as digits, so style is not scored as error. */
function norm(s) {
  return (String(s).toLowerCase().replace(/[\u2019']/g, "'").match(/[\p{L}\p{N}']+/gu) ?? []).filter((w) => !HESITATIONS.has(w)).map((w) => NUM[w] ?? w);
}

/** Word error rate: (substitutions + deletions + insertions) / reference words. */
export function wer(ref, hyp) {
  const r = norm(ref), h = norm(hyp);
  if (!r.length) return h.length ? 1 : 0;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[h.length] / r.length;
}

/** Of the listed terms the reference contains, how many the hypothesis spells exactly. */
function terms(ref, hyp) {
  const want = TERMS.filter((t) => ref.toLowerCase().includes(t.toLowerCase()));
  return { want: want.length, got: want.filter((t) => hyp.toLowerCase().includes(t.toLowerCase())).length };
}

const FILLERS = /\b(um+|uh+|er|ah|hmm+|you know|i mean)\b/i;

// ---- cleanup ----------------------------------------------------------------------------------

function cleanupPrompt(name) {
  if (!name || name === "default") return fs.readFileSync(CLEANUP_PROMPT, "utf8").replace(/\{\{agentName\}\}/g, "OpenWhispr").trim();
  const file = path.join(HERE, "prompts", `${name}.md`);
  return (fs.existsSync(file) ? parsePrompt(fs.readFileSync(file, "utf8")) : loadPrompt(name)).body;
}

let local = null;
function localModel() {
  if (local) return local;
  const cfgFile = path.join(HOME, "Library", "Application Support", "Arcforma", "ai-daemon.json");
  const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, "utf8")) : {};
  const model = process.env.ARCFORMA_EVAL_MODEL ?? cfg.local?.model;
  const binary = [process.env.ARCFORMA_EVAL_LLAMA, cfg.local?.binary].find((p) => p && fs.existsSync(p));
  local = new LocalModel({ binary, model, ctx: 8192, threads: 4, idleMinutes: 5 });
  return local;
}
const claude = new ClaudeRunner({ env: { ...process.env }, concurrency: 3, timeoutMs: 90_000 });

async function cleanup(engine, raw) {
  if (engine === "none") return { text: raw, ms: 0 };
  const [kind, a, b] = engine.split(":");
  const user = `<transcript>${raw}</transcript>`;
  const started = Date.now();
  if (kind === "local") {
    const r = await localModel().complete({ system: cleanupPrompt(a), user, maxTokens: Math.ceil(raw.length / 2) + 200, temperature: 0, timeoutMs: 60_000 });
    return { text: r.text.trim(), ms: Date.now() - started };
  }
  const r = await claude.complete({ system: cleanupPrompt(b), user, model: a, timeoutMs: 90_000 });
  return { text: r.ok ? r.text.trim() : "", ms: Date.now() - started, error: r.ok ? undefined : r.error };
}

// ---- runs -------------------------------------------------------------------------------------

const all = clips();
if (!all.length) {
  console.error(`No clips in ${AUDIO}`);
  process.exit(2);
}

if (has("draft")) {
  fs.mkdirSync(DATA, { recursive: true });
  const pk = await parakeetServer();
  const out = {};
  for (const c of all) {
    const buf = samples(c.file);
    const t0 = Date.now();
    const parakeet = await pk.transcribe(buf);
    const pMs = Date.now() - t0;
    const t1 = Date.now();
    const whisperText = whisper(c.file);
    out[c.id] = { seconds: +(buf.length / 4 / 16000).toFixed(1), parakeet, whisper: whisperText, reference: "", clean: "", parakeetMs: pMs, whisperMs: Date.now() - t1 };
    console.log(`${c.id} (${out[c.id].seconds}s) parakeet ${pMs} ms, whisper ${out[c.id].whisperMs} ms, disagree ${(wer(whisperText, parakeet) * 100).toFixed(0)}%`);
  }
  pk.stop();
  const file = path.join(DATA, "references.draft.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${file}`);
  process.exit(0);
}

const refsFile = path.join(DATA, "references.json");
if (!fs.existsSync(refsFile)) {
  console.error(`No ${refsFile}. Run --draft, correct it, save it as references.json.`);
  process.exit(2);
}
const refs = JSON.parse(fs.readFileSync(refsFile, "utf8"));
const scored = all.filter((c) => refs[c.id]?.reference);
const asrEngines = arg("asr", "parakeet,whisper").split(",");
const cleanEngines = arg("cleanup", "none,local:default,claude:claude-haiku-5-5:default").split(",");
const report = {};

const pk = asrEngines.includes("parakeet") ? await parakeetServer() : null;
const raw = {};
for (const asr of asrEngines) {
  let errs = 0, words = 0, tw = 0, tg = 0, audioS = 0, ms = 0;
  const per = [];
  for (const c of scored) {
    const buf = samples(c.file);
    const t0 = Date.now();
    const text = asr === "parakeet" ? await pk.transcribe(buf) : whisper(c.file);
    const took = Date.now() - t0;
    raw[`${asr}:${c.id}`] = text;
    const ref = refs[c.id].reference;
    const n = norm(ref).length;
    errs += wer(ref, text) * n;
    words += n;
    const t = terms(ref, text);
    tw += t.want;
    tg += t.got;
    audioS += buf.length / 4 / 16000;
    ms += took;
    per.push({ id: c.id, wer: wer(ref, text), ms: took, text });
  }
  report[asr] = { wer: errs / words, terms: `${tg}/${tw}`, realtime: ms / 1000 / audioS, per };
  console.log(`\n${asr}: WER ${(100 * errs / words).toFixed(1)}% over ${words} words, terms ${tg}/${tw}, ${(ms / 1000).toFixed(1)} s for ${audioS.toFixed(0)} s of audio (${(audioS / (ms / 1000)).toFixed(0)}x realtime)`);
  for (const p of per.filter((x) => x.wer > 0.1)) console.log(`  ${p.id} WER ${(p.wer * 100).toFixed(0)}%: ${JSON.stringify(p.text).slice(0, 160)}`);
}
pk?.stop();

// Cleanup is scored on what Parakeet actually produced, since that is what the app would clean.
const base = asrEngines.includes("parakeet") ? "parakeet" : asrEngines[0];
for (const eng of cleanEngines) {
  let errs = 0, words = 0, ms = 0, flags = 0;
  const per = [];
  for (const c of scored) {
    const clean = refs[c.id].clean || refs[c.id].reference;
    const r = await cleanup(eng, raw[`${base}:${c.id}`]);
    const n = norm(clean).length;
    errs += wer(clean, r.text) * n;
    words += n;
    ms += r.ms;
    const bad = [];
    if (FILLERS.test(r.text)) bad.push("filler left");
    if (/[—–]/.test(r.text)) bad.push("dash");
    if (r.error) bad.push(`error ${r.error}`);
    if (r.text.length > clean.length * 1.6 + 20) bad.push("grew");
    flags += bad.length ? 1 : 0;
    per.push({ id: c.id, wer: wer(clean, r.text), ms: r.ms, text: r.text, bad });
  }
  const sorted = per.map((p) => p.ms).sort((a, b) => a - b);
  report[`cleanup ${eng}`] = { wer: errs / words, flagged: flags, per };
  console.log(`\ncleanup ${eng} on ${base}: WER vs clean ${(100 * errs / words).toFixed(1)}%, flagged ${flags}/${per.length}, p50 ${sorted[Math.floor(sorted.length / 2)]} ms`);
  for (const p of per.filter((x) => x.bad.length || x.wer > 0.15)) console.log(`  ${p.id} WER ${(p.wer * 100).toFixed(0)}% ${p.bad.join(", ")}: ${JSON.stringify(p.text).slice(0, 160)}`);
}
local?.stop();
const out = arg("out", null);
if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
process.exit(0);
