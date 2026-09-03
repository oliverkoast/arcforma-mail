import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addAccount, readClientsFile, takenIds, writeClientsFile } from "./clients.js";

const ID_A = "111111111111-aaa1bbb2.apps.googleusercontent.com";
const ID_B = "222222222222-ccc3ddd4.apps.googleusercontent.com";

function tempFile(name = "oauth-clients.json"): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-clients-")), name);
}

const mode = (file: string) => fs.statSync(file).mode & 0o777;

test("the first account creates the file and its folder, readable only by the owner", () => {
  const file = path.join(tempFile("x"), "..", "nested", "oauth-clients.json");
  const entry = addAccount(file, { id: "arcforma", email: "You@Example.com", clientId: ID_A, clientSecret: "secret-a", consent: "internal" });
  assert.deepEqual(entry, { id: "arcforma", email: "you@example.com", clientId: ID_A, clientSecret: "secret-a", consent: "internal" });
  assert.equal(mode(file), 0o600);
  assert.deepEqual(readClientsFile(file).accounts, [entry]);
  // The shape is exactly what loadOAuthClients reads: one accounts array of flat objects.
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { accounts: unknown[] };
  assert.equal(parsed.accounts.length, 1);
});

test("a second account is appended, the first is untouched, and the file stays at 0600", () => {
  const file = tempFile();
  addAccount(file, { id: "arcforma", email: "you@example.com", clientId: ID_A, clientSecret: "secret-a", consent: "internal" });
  fs.chmodSync(file, 0o644);
  addAccount(file, { id: "personal", email: "you@gmail.com", clientId: ID_B, clientSecret: "secret-b", consent: "external" });
  const after = readClientsFile(file).accounts;
  assert.deepEqual(after.map((a) => a.id), ["arcforma", "personal"]);
  assert.equal(after[0]?.clientSecret, "secret-a", "the first account's secret survives the append");
  assert.equal(after[1]?.consent, "external");
  assert.equal(mode(file), 0o600, "a loosened file is tightened again on the next write");
  assert.deepEqual(takenIds(file), ["arcforma", "personal"]);
});

test("a duplicate slot id, address, or client id is refused and nothing on disk changes", () => {
  const file = tempFile();
  addAccount(file, { id: "arcforma", email: "you@example.com", clientId: ID_A, clientSecret: "secret-a", consent: "internal" });
  const before = fs.readFileSync(file, "utf8");

  assert.throws(() => addAccount(file, { id: "arcforma", email: "other@example.com", clientId: ID_B, clientSecret: "s", consent: "internal" }), /already has an account called arcforma/);
  assert.throws(() => addAccount(file, { id: "second", email: "YOU@example.com", clientId: ID_B, clientSecret: "s", consent: "internal" }), /already in/);
  assert.throws(() => addAccount(file, { id: "second", email: "other@example.com", clientId: ID_A, clientSecret: "s", consent: "internal" }), /own OAuth client/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("a bad client id, secret, address, or slot id is refused before anything is written", () => {
  const file = tempFile();
  assert.throws(() => addAccount(file, { id: "a", email: "you@example.com", clientId: "nope", clientSecret: "s", consent: "internal" }), /apps\.googleusercontent\.com/);
  assert.throws(() => addAccount(file, { id: "a", email: "you@example.com", clientId: ID_A, clientSecret: "", consent: "internal" }), /Paste the client secret/);
  assert.throws(() => addAccount(file, { id: "a", email: "nope", clientId: ID_A, clientSecret: "s", consent: "internal" }), /email address/);
  assert.throws(() => addAccount(file, { id: "Not An Id", email: "you@example.com", clientId: ID_A, clientSecret: "s", consent: "internal" }), /slot id is lowercase/);
  assert.equal(fs.existsSync(file), false);
});

test("an existing hand-written file keeps every entry, including one still waiting for its credentials", () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ accounts: [{ id: "legacy", email: "old@example.com", clientId: "", clientSecret: "", consent: "internal" }] }));
  addAccount(file, { id: "arcforma", email: "you@example.com", clientId: ID_A, clientSecret: "secret-a", consent: "internal" });
  const after = readClientsFile(file).accounts;
  assert.deepEqual(after.map((a) => a.id), ["legacy", "arcforma"]);
  assert.equal(after[0]?.clientId, "", "the blank template row is kept rather than dropped");
});

test("a file that is not JSON is left alone rather than overwritten", () => {
  const file = tempFile();
  fs.writeFileSync(file, "{ this is not json");
  assert.throws(() => readClientsFile(file), /not valid JSON/);
  assert.throws(() => addAccount(file, { id: "a", email: "you@example.com", clientId: ID_A, clientSecret: "s", consent: "internal" }), /not valid JSON/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ this is not json");
});

test("a missing file reads as empty, and a direct write lands at 0600", () => {
  const file = tempFile();
  assert.deepEqual(readClientsFile(file), { accounts: [] });
  assert.deepEqual(takenIds(file), []);
  writeClientsFile(file, { accounts: [] });
  assert.equal(mode(file), 0o600);
});
