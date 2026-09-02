import { ipcMain } from "electron";
import { createSavedSearch, deleteSavedSearch, getSidebarLayout, listSavedSearches, setSidebarLayout, sidebarCounts, updateSavedSearch, type Db } from "@arcforma/store";
import { log } from "../log.js";
import type { SavedSearchInfo, SidebarLayout } from "../../shared/types.js";

export function savedSearchInfos(db: Db): SavedSearchInfo[] {
  return listSavedSearches(db).map((s) => ({ id: s.id, name: s.name, query: s.query }));
}

/** Loose shape check on the way in: the renderer owns the layout, the store only keeps it. */
function isLayout(v: unknown): v is SidebarLayout {
  if (!v || typeof v !== "object") return false;
  const l = v as { version?: unknown; groups?: unknown };
  return l.version === 1 && Array.isArray(l.groups) && l.groups.every((g) => g && typeof g === "object" && typeof (g as { id?: unknown }).id === "string" && Array.isArray((g as { rows?: unknown }).rows));
}

export function registerSidebarIpc(db: Db): void {
  ipcMain.handle("sidebar:counts", (_e, accountIds?: string[]) => sidebarCounts(db, accountIds));
  ipcMain.handle("sidebar:getLayout", () => {
    const stored = getSidebarLayout(db);
    return isLayout(stored) ? stored : null;
  });
  ipcMain.handle("sidebar:setLayout", (_e, layout: unknown) => {
    if (!isLayout(layout)) throw new Error("That sidebar layout is not in a shape the app can keep.");
    setSidebarLayout(db, layout);
  });

  ipcMain.handle("searches:list", () => savedSearchInfos(db));
  ipcMain.handle("searches:create", (_e, name: string, query: string) => {
    if (listSavedSearches(db).some((s) => s.name.toLowerCase() === String(name).trim().toLowerCase())) throw new Error(`A saved search named ${String(name).trim()} already exists.`);
    const row = createSavedSearch(db, { name: String(name), query: String(query) });
    log("sidebar", `saved search ${row.id} created: ${row.query}`);
    return savedSearchInfos(db);
  });
  ipcMain.handle("searches:update", (_e, id: number, patch: { name?: string; query?: string }) => {
    if (!updateSavedSearch(db, Number(id), { name: patch.name, query: patch.query })) throw new Error("That saved search is gone.");
    return savedSearchInfos(db);
  });
  ipcMain.handle("searches:delete", (_e, id: number) => {
    deleteSavedSearch(db, Number(id));
    return savedSearchInfos(db);
  });
}
