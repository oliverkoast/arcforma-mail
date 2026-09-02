#!/usr/bin/env node
/**
 * Refuses anything that looks like a credential. Runs in CI and is worth running before a push.
 * Patterns are deliberately narrow: a false alarm on every base64 string would train people to ignore it.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";

const PATTERNS = [
  [/GOCSPX-[A-Za-z0-9_-]{10,}/, "a Google OAuth client secret"],
  [/ya29\.[A-Za-z0-9_-]{20,}/, "a Google access token"],
  [/\b\d{9,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com\b/, "a real Google OAuth client id"],
  [/sk-[A-Za-z0-9]{32,}/, "an API key"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/AKIA[0-9A-Z]{16}/, "an AWS access key id"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "a private key"],
  [/"refresh_token"\s*:\s*"[A-Za-z0-9._-]{20,}"/, "a stored refresh token"],
];

const files = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);
let bad = 0;
for (const file of files) {
  if (/\.(png|jpg|jpeg|webp|gif|icns|ttf|otf|woff2?|gguf|zip|dmg)$/i.test(file)) continue;
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
  for (const [re, what] of PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const line = text.slice(0, m.index).split("\n").length;
    console.error(`${file}:${line} looks like ${what}`);
    bad++;
  }
}
if (bad > 0) {
  console.error(`\nsecret-scan: ${bad} finding(s). Nothing that opens a mailbox belongs in this repository.`);
  process.exit(1);
}
console.log(`secret-scan: clean (${files.length} files)`);
