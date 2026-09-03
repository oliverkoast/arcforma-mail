// Applies the sender rule to every IPC handler so none can forget it. Electron's security
// checklist puts this at item 17: validate the sender of every message, because a renderer that
// has been taken over otherwise inherits the main process's full authority. Today the renderer
// only loads app:// content and navigation is locked, so this is depth rather than a hole; it is
// also the difference between one bug in message rendering and someone reading the whole mailbox.
//
// Call installIpcSenderGuard() once, before any handler registers.

import { ipcMain, type IpcMainInvokeEvent, type WebFrameMain } from "electron";
import { isTrustedSender } from "./ipc-sender.js";

/**
 * Returning rather than throwing on a refusal keeps a hostile frame from learning anything from
 * the shape of the error. The log line carries the URL because a refusal here is worth reading.
 */
export function installIpcSenderGuard(opts: { devOrigin?: string; log?: (message: string) => void } = {}): void {
  const original = ipcMain.handle.bind(ipcMain);
  const log = opts.log ?? (() => {});
  ipcMain.handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    original(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!isTrustedSender(event.senderFrame as WebFrameMain | null, opts.devOrigin)) {
        log(`refused ${channel} from ${event.senderFrame?.url ?? "an unknown frame"}`);
        return undefined;
      }
      return listener(event, ...args);
    });
  };
}
