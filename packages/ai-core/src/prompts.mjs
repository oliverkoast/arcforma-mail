import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts");

/** Parse a prompt file: YAML-ish front matter (flat key: value) plus body. */
export function parsePrompt(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^".*"$/.test(v)) v = v.slice(1, -1);
    else if (/^\d+$/.test(v)) v = Number(v);
    meta[kv[1]] = v;
  }
  return { meta, body: m[2].trim() };
}

const cache = new Map();
export function loadPrompt(task) {
  if (!cache.has(task)) {
    const file = path.join(DIR, `${task}.md`);
    if (!fs.existsSync(file)) throw Object.assign(new Error(`unknown task ${task}`), { code: "unknown_task" });
    cache.set(task, parsePrompt(fs.readFileSync(file, "utf8")));
  }
  return cache.get(task);
}

export function voiceRules() {
  return fs.readFileSync(path.join(DIR, "_voice-rules.md"), "utf8").trim();
}

/** Fill {{placeholders}}; unknown ones become an empty string. */
export function render(body, vars) {
  return body.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? "")).replace(/\n{3,}/g, "\n\n").trim();
}

export function listTasks() {
  return fs.readdirSync(DIR).filter((f) => f.endsWith(".md") && !f.startsWith("_")).map((f) => f.replace(/\.md$/, ""));
}

/** Strip the completion marker; throw when it is missing or the result is empty. */
export function extractMarked(text, marker) {
  if (!marker) return text;
  if (typeof text !== "string" || !text.trimEnd().endsWith(marker)) {
    throw Object.assign(new Error("model output ended before the completion marker"), { code: "incomplete" });
  }
  const t = text.trimEnd();
  const out = t.slice(0, t.length - marker.length).replace(/\s+$/, "");
  if (!out.trim()) throw Object.assign(new Error("model returned empty text"), { code: "empty" });
  return out;
}
