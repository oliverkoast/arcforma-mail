// F-MAIL-01: placeholder app icon. A flat cobalt (#0845AC) rounded square,
// written as a 1024 px PNG with no image library, then resized with sips and
// packed with iconutil. Regenerate from the standalone mark once F-02 lands.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(here, "..", "build");
fs.mkdirSync(buildDir, { recursive: true });

const SIZE = 1024;
const COBALT = [0x08, 0x45, 0xac];
// macOS icon grid: the artwork sits inside a 824 px square on the 1024 canvas.
const INSET = 100;
const RADIUS = 180;

function inside(x, y) {
  const x0 = INSET, y0 = INSET, x1 = SIZE - INSET, y1 = SIZE - INSET;
  if (x < x0 || x >= x1 || y < y0 || y >= y1) return 0;
  const cx = x < x0 + RADIUS ? x0 + RADIUS : x >= x1 - RADIUS ? x1 - RADIUS - 1 : null;
  const cy = y < y0 + RADIUS ? y0 + RADIUS : y >= y1 - RADIUS ? y1 - RADIUS - 1 : null;
  if (cx === null || cy === null) return 1;
  const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
  return d <= RADIUS - 0.5 ? 1 : d >= RADIUS + 0.5 ? 0 : RADIUS + 0.5 - d;
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  for (let x = 0; x < SIZE; x++) {
    const a = inside(x, y);
    const o = y * (SIZE * 4 + 1) + 1 + x * 4;
    raw[o] = COBALT[0];
    raw[o + 1] = COBALT[1];
    raw[o + 2] = COBALT[2];
    raw[o + 3] = Math.round(a * 255);
  }
}

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const master = path.join(buildDir, "icon-1024.png");
fs.writeFileSync(master, png);

const iconset = fs.mkdtempSync(path.join(os.tmpdir(), "arcmail-iconset-"));
const set = path.join(iconset, "icon.iconset");
fs.mkdirSync(set);
for (const [name, px] of [
  ["icon_16x16.png", 16], ["icon_16x16@2x.png", 32], ["icon_32x32.png", 32], ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128], ["icon_128x128@2x.png", 256], ["icon_256x256.png", 256], ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512], ["icon_512x512@2x.png", 1024],
]) {
  execFileSync("sips", ["-z", String(px), String(px), master, "--out", path.join(set, name)], { stdio: "ignore" });
}
execFileSync("iconutil", ["-c", "icns", set, "-o", path.join(buildDir, "icon.icns")]);
fs.rmSync(iconset, { recursive: true, force: true });
console.log(`make-icon: ${path.join(buildDir, "icon.icns")} (placeholder, see qa/FINDINGS.md F-MAIL-01)`);
