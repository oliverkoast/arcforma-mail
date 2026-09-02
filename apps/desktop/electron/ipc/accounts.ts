import { app, ipcMain } from "electron";
import type { Db } from "@arcforma/store";
import type { AccountRegistry } from "../accounts.js";
import { log } from "../log.js";
import { loginItemAllowed } from "../login-item.js";
import type { SyncManager } from "../sync.js";
import { requireAccount } from "./guard.js";
import type { LoginItemInfo } from "../../shared/types.js";

const LOGIN_KEY = "openAtLogin";

/** Stored preference for the login item; on by default. Kept in the settings table under its own key. */
export function readOpenAtLogin(db: Db): boolean {
  const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(LOGIN_KEY) as { value_json: string } | undefined;
  if (!row) return true;
  try {
    return JSON.parse(row.value_json) !== false;
  } catch {
    return true;
  }
}

function writeOpenAtLogin(db: Db, value: boolean): void {
  db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at").run(LOGIN_KEY, JSON.stringify(value), Date.now());
}

/** Only a packed app registers itself; dev and smoke runs would otherwise add the bare Electron binary to Login Items. */
export function loginItemSupported(): boolean {
  return loginItemAllowed({ isPackaged: app.isPackaged, platform: process.platform, smoke: process.env["ARCMAIL_SMOKE"] });
}

/** Makes the OS setting match the stored preference. Called once at boot and after every toggle. */
export function applyLoginItem(db: Db): LoginItemInfo {
  const openAtLogin = readOpenAtLogin(db);
  const supported = loginItemSupported();
  if (supported) {
    const current = app.getLoginItemSettings().openAtLogin;
    if (current !== openAtLogin) {
      app.setLoginItemSettings({ openAtLogin });
      log("app", `login item ${openAtLogin ? "on" : "off"}`);
    }
  }
  return { openAtLogin, supported };
}

export function registerAccountIpc(accounts: AccountRegistry, sync: SyncManager, db: Db): void {
  ipcMain.handle("accounts:status", () => accounts.status());
  ipcMain.handle("accounts:signIn", async (_e, accountId: string) => {
    requireAccount(db, accountId);
    const status = await accounts.signIn(accountId);
    sync.poke(accountId, 0);
    return status;
  });
  ipcMain.handle("accounts:signOut", (_e, accountId: string) => {
    requireAccount(db, accountId);
    return accounts.signOut(accountId);
  });
  ipcMain.handle("app:loginItem", (): LoginItemInfo => applyLoginItem(db));
  ipcMain.handle("app:setLoginItem", (_e, openAtLogin: boolean): LoginItemInfo => {
    writeOpenAtLogin(db, Boolean(openAtLogin));
    return applyLoginItem(db);
  });
}
