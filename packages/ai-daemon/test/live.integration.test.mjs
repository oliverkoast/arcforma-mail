// Talks to the installed daemon if it is running (config file present and health answers). Skips otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CONFIG_FILE } from "../src/config.mjs";

let cfg = null;
try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch {}
const base = cfg ? `http://127.0.0.1:${cfg.port}` : null;
let alive = false;
if (base) { try { alive = (await fetch(`${base}/v1/health`)).ok; } catch {} }

test("installed daemon: health, auth gate, classify on the local model, and a typed Claude result", { skip: !alive, timeout: 180_000 }, async () => {
  const h = await (await fetch(`${base}/v1/health`)).json();
  assert.equal(h.ok, true);
  assert.ok(["ok", "signed_out"].includes(h.claude));
  const headers = { "content-type": "application/json", authorization: `Bearer ${cfg.token}` };
  assert.equal((await fetch(`${base}/v1/complete`, { method: "POST", headers: { ...headers, authorization: "Bearer nope" }, body: JSON.stringify({ user: "x" }) })).status, 401);
  const schema = { type: "object", properties: { split: { type: "string", enum: ["important", "other"] }, type: { type: "string", enum: ["newsletter", "calendar", "notification", "receipt", "none"] }, category: { type: "string" }, confidence: { type: "number" } }, required: ["split", "type", "category", "confidence"], additionalProperties: false };
  const c = await fetch(`${base}/v1/classify`, { method: "POST", headers, body: JSON.stringify({ text: "From: Stripe <receipts@stripe.com>\nSubject: Your receipt\n\nAmount paid $19.00.", schema, vars: { categories: "Billing: invoices and receipts", examples: "(none)" } }) });
  if (c.status === 503) { const j = await c.json(); assert.equal(j.code, "local_missing"); return; }
  assert.equal(c.status, 200);
  const cj = await c.json();
  assert.equal(cj.json.type, "receipt");
  const r = await fetch(`${base}/v1/complete`, { method: "POST", headers, body: JSON.stringify({ task: "grammar_fix", user: JSON.stringify({ selectedText: "teh cat sat" }), timeoutMs: 60_000 }) });
  const rj = await r.json();
  if (h.claude === "signed_out") { assert.equal(r.status, 503); assert.equal(rj.code, "not_logged_in"); }
  else { assert.equal(r.status, 200); assert.match(rj.text, /the cat sat/i); assert.ok(!/—/.test(rj.text)); }
});
