#!/usr/bin/env node
// Build-time brand gate for the desktop renderer. The app consumes the brand
// verbatim through --af-* variables, so the renderer source must never carry
// its own colours, faces, shadows, hairlines, or a redrawn wordmark.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "apps", "desktop");
const targets = [path.join(root, "src"), path.join(root, "index.html")];

const rules = [
  { name: "raw hex colour", re: /#[0-9a-fA-F]{3,8}\b/, only: /\.(css|tsx|ts|html)$/ },
  { name: "font-family declaration", re: /font-family\s*:/, only: /\.(css|tsx|ts|html)$/ },
  { name: "box-shadow", re: /box-shadow\s*:/, only: /\.(css|tsx|ts|html)$/ },
  {
    name: "border not using --af-rule",
    re: /\bborder(?:-(?:top|right|bottom|left))?\s*:(?!\s*(?:0|none)\s*[;}])(?![^;]*var\(--af-rule\))/,
    only: /\.(css|tsx|ts)$/,
  },
  // Brand artwork is files. A small UI glyph (a trash can, a chevron) is not brand artwork, so an
  // inline SVG is allowed only when it is clearly a glyph: hidden from assistive tech and not the
  // wordmark's geometry.
  { name: "inline wordmark (the wordmark is a file, never paths)", re: /viewBox="0 0 291\.64 48\.3"|<svg[^>]*wordmark/i, only: /\.(tsx|ts|html)$/ },
  { name: "inline SVG without aria-hidden (glyphs must be decorative; artwork must be a file)", re: /<svg\b(?![^>]*aria-hidden="true")/, only: /\.(tsx|ts|html)$/ },
];

function walk(p, out) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) walk(path.join(p, e), out);
  } else out.push(p);
}

const files = [];
for (const t of targets) if (fs.existsSync(t)) walk(t, files);

let hits = 0;
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (const rule of rules) {
    if (!rule.only.test(file)) continue;
    lines.forEach((line, i) => {
      if (rule.re.test(line)) {
        hits += 1;
        console.log(`${path.relative(root, file)}:${i + 1}: ${rule.name}: ${line.trim()}`);
      }
    });
  }
}

if (hits) {
  console.error(`brand-check: ${hits} hit(s). Use --af-* variables from /brand/styles.css.`);
  process.exit(1);
}
console.log(`brand-check: clean (${files.length} files)`);
