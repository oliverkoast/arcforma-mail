// User-supplied artwork served from the app's data folder through app://.
// Today that is one file: inbox-zero.webp (or .png, .jpg) shown on an empty
// inbox or queue. It is not a brand asset; see qa/FINDINGS.md F-MAIL-07.

import fs from "node:fs";
import path from "node:path";

export const USER_ART_ROUTE = "/user-art/";

const ART_TYPES: Array<{ ext: string; type: string }> = [
  { ext: ".webp", type: "image/webp" },
  { ext: ".png", type: "image/png" },
  { ext: ".jpg", type: "image/jpeg" },
  { ext: ".jpeg", type: "image/jpeg" },
];

/** Names the app will look for. Anything else on the route is a 404. */
const KNOWN = new Set(["inbox-zero"]);

/** Resolves /user-art/<name> to a file in userData, first extension that exists wins. */
export function findUserArt(userData: string, name: string): { file: string; type: string } | null {
  if (!KNOWN.has(name)) return null;
  for (const { ext, type } of ART_TYPES) {
    const file = path.join(userData, `${name}${ext}`);
    try {
      if (fs.statSync(file).isFile()) return { file, type };
    } catch {
      // Try the next extension.
    }
  }
  return null;
}

/** The art names present, so the renderer can skip a request it knows would 404. */
export function listUserArt(userData: string): string[] {
  return Array.from(KNOWN).filter((n) => findUserArt(userData, n) !== null);
}
