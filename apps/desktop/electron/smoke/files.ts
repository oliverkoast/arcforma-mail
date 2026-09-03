// Two real files, built here rather than committed as binary: a one-page PDF
// and a small PNG. The smoke walk seeds them as attachments so the preview
// windows it photographs are rendering actual bytes through the actual cache,
// not a placeholder.
//
// Both are written by hand from the format specs so the repository carries no
// binary blobs and no new dependency.

import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

/** A width by height truecolour PNG with a diagonal band, so the preview shows something with an edge in it. */
export function makePng(width = 240, height = 160): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  // 10, 11, 12 stay 0: deflate, adaptive filtering, no interlace.
  const raw = Buffer.alloc(height * (1 + width * 3));
  let at = 0;
  for (let y = 0; y < height; y++) {
    raw[at++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const band = (x + y) % 60 < 30;
      raw[at++] = band ? 0x08 : 0xf7;
      raw[at++] = band ? 0x45 : 0xf7;
      raw[at++] = band ? 0xac : 0xf8;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A one-page PDF with a few lines of text. The cross-reference table needs the
 * byte offset of every object, so the objects are laid out first and the table
 * is built from where they landed.
 */
export function makePdf(lines: string[] = ["Session plan", "Northwind, Tuesday 9:00", "Three blocks of ninety minutes"]): Buffer {
  const content = [
    "BT",
    "/F1 24 Tf 64 700 Td (" + escapePdf(lines[0] ?? "") + ") Tj",
    "ET",
    ...lines.slice(1).map((line, i) => `BT /F1 13 Tf 64 ${660 - i * 22} Td (${escapePdf(line)}) Tj ET`),
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function escapePdf(text: string): string {
  return text.replace(/([\\()])/g, "\\$1");
}

/** base64url, the encoding Gmail hands attachment bytes over in and the store keeps an inline part as. */
export function toBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
