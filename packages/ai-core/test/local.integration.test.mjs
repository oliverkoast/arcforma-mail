// Runs only when the local model and llama-server exist on this machine. Exercises the real classifier.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AiService } from "../src/service.mjs";

const bin = path.join(os.homedir(), "Projects", "openwhispr", "resources", "bin");
const local = { binary: path.join(bin, "llama-server-darwin-arm64"), libDir: bin, model: path.join(os.homedir(), "Library", "Application Support", "Arcforma", "models", "qwen3-4b-instruct-q4_k_m.gguf") };
const available = fs.existsSync(local.binary) && fs.existsSync(local.model) && !process.env.CI;

test("local classifier returns schema-valid JSON for a receipt and a client email", { skip: !available, timeout: 180_000 }, async () => {
  const svc = new AiService({ local });
  const schema = { type: "object", properties: { split: { type: "string", enum: ["important", "other"] }, type: { type: "string", enum: ["newsletter", "calendar", "notification", "receipt", "none"] }, category: { type: "string" }, confidence: { type: "number" } }, required: ["split", "type", "category", "confidence"], additionalProperties: false };
  const vars = { categories: "Clients: mail from people at client companies about active engagements\nBilling: invoices, receipts, payment questions", examples: "(none)" };
  try {
    const receipt = await svc.classifyLocal({ text: "From: Stripe <receipts@stripe.com>\nSubject: Your receipt from Render\n\nAmount paid $19.00.", schema, vars });
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(receipt.json.type, "receipt");
    const client = await svc.classifyLocal({ text: "From: Sarah Chen <sarah@jamesperse.com>\nSubject: Portal kickoff\n\nHi Oliver, can we lock Monday's agenda? Sarah", schema, vars });
    assert.equal(client.ok, true);
    assert.equal(client.json.split, "important");
    assert.ok(client.latencyMs < 5000, `latency ${client.latencyMs}`);
  } finally { svc.stop(); }
});
