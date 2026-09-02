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
