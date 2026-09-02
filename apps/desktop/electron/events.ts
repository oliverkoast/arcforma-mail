import { createRequire } from "node:module";
import type { ArcmailEvents, EventChannel } from "../shared/types.js";

// Electron is resolved at call time rather than imported, so the sync,
// scheduler, and classifier modules that emit events can be exercised by
// node:test outside Electron. There, "electron" resolves to the binary path
// and emit is a no-op.
const req = createRequire(import.meta.url);

interface WindowLike {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: unknown): void };
}

function windows(): WindowLike[] {
  try {
    const electron = req("electron") as { BrowserWindow?: { getAllWindows(): WindowLike[] } };
    return electron?.BrowserWindow?.getAllWindows?.() ?? [];
  } catch {
    return [];
  }
}

/** Pushes an event to every renderer window. */
export function emit<C extends EventChannel>(channel: C, payload: ArcmailEvents[C]): void {
  for (const win of windows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}
