// Navigation policy for every WebContents the app ever owns. The renderer is
// served from one origin (app://mail) and must stay there: a link in a mail
// body opens in the default browser, never inside the app, and nothing may
// steer any frame to http, file, javascript, or data URLs. In dev the Vite
// server origin stands in for app://mail. Pure so node:test can drive it.

export const APP_ORIGIN = "app://mail";

export interface NavigationPolicy {
  /** The Vite dev server URL when running under `pnpm dev`; undefined in a packed app. */
  devUrl?: string | undefined;
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    // Node's URL reports origin "null" for a non-special scheme such as app:,
    // so the origin is built from the parsed scheme and host instead.
    if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
    if (u.protocol !== "app:" || !u.host) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** True only for the app's own origin (app://mail, or the dev server while it is running). */
export function isAllowedNavigation(url: string, policy: NavigationPolicy = {}): boolean {
  const origin = originOf(url);
  if (!origin) return false;
  if (origin === APP_ORIGIN) return true;
  if (policy.devUrl) {
    const dev = originOf(policy.devUrl);
    if (dev && origin === dev) return true;
  }
  return false;
}

/** Links the user may follow in their browser: http and https only. Everything else is dropped. */
export function isExternalLink(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Chromium's built-in PDF viewer. A window showing a PDF loads the viewer as an
 * internal extension frame under this fixed id, so a preview window that is
 * rendering a PDF has to let that one frame load or it shows nothing. It is a
 * frame Chromium creates for itself out of the browser's own resources; no
 * bytes from the network reach it, and no other extension origin is allowed.
 */
export const PDF_VIEWER_ORIGIN = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai";

/**
 * The navigation policy for an attachment preview window, which is stricter
 * than the app's. Such a window shows exactly one thing and must never become a
 * way to reach anything else. Two URLs are pinned to it: its own page, and the
 * one attachment route that page frames for a PDF. Those, the blank page it
 * starts on, and Chromium's PDF viewer frame are all it may reach. Every other
 * URL is refused, including the app's own pages, another attachment's route,
 * http and https of any kind, and file:, data:, and javascript: URLs.
 */
export function isPreviewNavigation(url: string, pinnedUrls: string | readonly string[]): boolean {
  if (!url) return false;
  if (url === "about:blank") return true;
  const pinned = typeof pinnedUrls === "string" ? [pinnedUrls] : pinnedUrls;
  for (const p of pinned) {
    if (p && stripFragment(url) === stripFragment(p)) return true;
  }
  return url === PDF_VIEWER_ORIGIN || url.startsWith(`${PDF_VIEWER_ORIGIN}/`);
}

function stripFragment(url: string): string {
  const at = url.indexOf("#");
  return at === -1 ? url : url.slice(0, at);
}
