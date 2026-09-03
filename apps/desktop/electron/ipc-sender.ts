// Who is allowed to speak to the main process. Kept free of any electron import on purpose: a
// module that imports electron cannot be unit tested under plain node, and this is the rule the
// whole IPC surface depends on, so it is the last thing that should go untested.

/** The one origin the renderer is ever served from. Kept in step with the protocol handler in main.ts. */
export const APP_ORIGIN = "app://mail";

export interface SenderLike {
  url: string;
  parent?: unknown;
}

/**
 * A message is legitimate when it comes from the top frame of a window we served ourselves.
 * A subframe is never legitimate: message bodies render in sandboxed iframes, and one of those
 * asking the main process for anything is the exact attack this guard exists to stop.
 */
export function isTrustedSender(frame: SenderLike | null | undefined, devOrigin?: string): boolean {
  if (!frame) return false;
  if (frame.parent) return false;
  let origin: string;
  try {
    const url = new URL(frame.url);
    origin = `${url.protocol}//${url.host}`;
  } catch {
    return false;
  }
  if (origin === APP_ORIGIN) return true;
  return Boolean(devOrigin && origin === devOrigin);
}
