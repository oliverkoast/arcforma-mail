import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore, setSetting, setLoadImages, getContact } from "@arcforma/store";
import { shouldLoadImages } from "../images.js";

function db() {
  return openStore(":memory:");
}
const inbound = { from_email: "sender@y.com", direction: "in" as const };
const outbound = { from_email: "me@x.com", direction: "out" as const };

test("default setting loads images from everyone", () => {
  const d = db();
  assert.equal(shouldLoadImages(d, inbound, null), true);
  assert.equal(shouldLoadImages(d, inbound, 0), true, "a contact row with no choice does not block");
});

test("a per-sender block wins over the setting, and a per-sender allow wins over never", () => {
  const d = db();
  setLoadImages(d, "sender@y.com", false);
  assert.equal(getContact(d, "sender@y.com")?.load_images, -1);
  assert.equal(shouldLoadImages(d, inbound, -1), false);
  setSetting(d, "remoteImages", "never");
  assert.equal(shouldLoadImages(d, inbound, null), false);
  assert.equal(shouldLoadImages(d, inbound, 1), true);
});

test("known mode loads for own mail and for senders with a two-way thread only", () => {
  const d = db();
  setSetting(d, "remoteImages", "known");
  assert.equal(shouldLoadImages(d, outbound, null), true);
  assert.equal(shouldLoadImages(d, inbound, null), false, "no history yet");
});
