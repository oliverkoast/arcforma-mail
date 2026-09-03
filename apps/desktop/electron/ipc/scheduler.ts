import path from "node:path";
import { app, ipcMain, shell } from "electron";
import type { Db } from "@arcforma/store";
import type { Scheduler } from "../scheduler.js";
import type { SyncManager } from "../sync.js";
import { listUserArt } from "../user-art.js";
import { log, logError, logFilePath } from "../log.js";
import type { AppInfo } from "../../shared/types.js";

export function registerSchedulerIpc(_db: Db, scheduler: Scheduler, sync: SyncManager): void {
  ipcMain.handle("scheduler:status", () => scheduler.status());
  ipcMain.handle("sync:now", () => sync.pokeAll());
  ipcMain.handle("app:reportCrash", (_e, report: { message?: unknown; stack?: unknown; componentStack?: unknown }): void => {
    // Recorded, never re-thrown. The renderer is already showing the person what happened.
    logError("renderer", "the interface stopped drawing", String(report?.message ?? "no message"));
    for (const [name, value] of [["stack", report?.stack], ["componentStack", report?.componentStack]] as const) {
      if (typeof value === "string" && value.trim()) log("renderer", `${name}: ${value.slice(0, 4000)}`);
    }
  });
  ipcMain.handle("app:openLogFolder", (): void => {
    const file = logFilePath();
    if (file) shell.showItemInFolder(file);
    else shell.openPath(path.join(app.getPath("userData"), "logs"));
  });
  ipcMain.handle("app:info", (): AppInfo => ({ version: app.getVersion(), platform: process.platform, smoke: Boolean(process.env["ARCMAIL_SMOKE"]), userArt: listUserArt(app.getPath("userData")) }));
  // The renderer's clock is the same machine's; a value in the future or the far past is clamped to now.
  ipcMain.handle("app:activity", (_e, at: unknown) => {
    const now = Date.now();
    const t = typeof at === "number" && Number.isFinite(at) && at <= now && at > now - 3_600_000 ? at : now;
    scheduler.noteActivity(t);
  });
}
