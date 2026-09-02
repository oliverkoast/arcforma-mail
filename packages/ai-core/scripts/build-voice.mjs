#!/usr/bin/env node
/**
 * Builds the voice profile from a sample of the owner's sent mail.
 *
 * Input: a JSON file, an array of {account, to, subject, text} for sent
 * messages with quoted history and signatures already stripped. The mail app
 * exports this from its store (Settings > Voice > Export sample), or pass
 * any hand-made sample. Output: src/voice/oliver.voice.md, which every
 * drafting prompt includes.
 *
 * Usage: node scripts/build-voice.mjs sample.json [--out path] [--daemon]
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { AiService } from "../src/service.mjs";


export function selectSample(messages, max = 300) {
  const clean = messages
    .map((m) => ({ ...m, text: stripQuotesAndSignature(m.text ?? "") }))
    .filter((m) => m.text.split(/\s+/).length >= 8 && m.text.length <= 4000);
  // Spread across accounts so one domain does not dominate the profile.
  const byAccount = new Map();
  for (const m of clean) { const k = m.account ?? "default"; if (!byAccount.has(k)) byAccount.set(k, []); byAccount.get(k).push(m); }
  const picked = [];
  const per = Math.ceil(max / byAccount.size);
  for (const list of byAccount.values()) picked.push(...list.slice(0, per));
  return picked.slice(0, max);
}

export function stripQuotesAndSignature(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const kept = [];
  for (const line of lines) {
    if (/^On .{5,120} wrote:\s*$/.test(line)) break;
    if (/^-{2,}\s*Original Message/i.test(line)) break;
    if (/^From: .+$/.test(line) && kept.length > 2) break;
    if (/^(--|__)\s*$/.test(line)) break;
    if (/^>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

export function buildPrompt(messages) {
  const exemplars = messages.map((m, i) => `[${i + 1}] to ${m.to ?? "?"} (${m.account ?? "?"}), subject "${m.subject ?? ""}"\n${m.text}`).join("\n\n");
  return {
    system: [
      "You are analysing how one person writes email so an assistant can draft in their voice.",
      "Return a markdown profile with these sections, each a short list of concrete, observed habits with a quoted example where useful:",
      "Greetings; Sign-offs; Sentence length and rhythm; Formality by audience (note differences between accounts or recipient types); Phrases they use; Phrases they never use; How they ask for things; How they say no or push back; Structure (paragraphs, lists, one-liners).",
      "Then a section 'Exemplars' with 12 verbatim messages that best represent the voice, chosen for variety, copied exactly.",
      "Do not invent habits that the sample does not show. No emojis. No em dashes.",
    ].join(" "),
    user: `Sent messages (${messages.length}):\n\n${exemplars}`,
  };
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith("--"));
if (!input) { console.error("usage: build-voice.mjs sample.json [--out path]"); process.exit(2); }
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args[outIdx + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "voice", "oliver.voice.md");
const sample = JSON.parse(fs.readFileSync(input, "utf8"));
if (!Array.isArray(sample) || sample.length < 5) { console.error("need at least 5 sent messages"); process.exit(2); }
const picked = selectSample(sample);
console.log(`using ${picked.length} of ${sample.length} messages`);
const svc = new AiService();
const { system, user } = buildPrompt(picked);
const r = await svc.complete({ system, user, timeoutMs: 180_000 });
if (!r.ok) { console.error("failed:", r.code, r.error); process.exit(1); }
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `# Voice profile\n\nGenerated ${new Date().toISOString().slice(0, 10)} from ${picked.length} sent messages. Regenerate with scripts/build-voice.mjs.\n\n${r.text.trim()}\n`);
console.log(`wrote ${out} (${r.model}, ${r.latencyMs} ms)`);
}
