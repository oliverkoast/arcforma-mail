import { ipcMain } from "electron";
import { search, type Db } from "@arcforma/store";
import { toSummary } from "./threads.js";
import type { SearchHitView } from "../../shared/types.js";

export function registerSearchIpc(db: Db): void {
  ipcMain.handle("search:query", (_e, query: string, accountIds?: string[]): SearchHitView[] =>
    search(db, query, { accountIds, limit: 60 }).map((h) => ({ thread: toSummary(h.row), messageId: h.messageId, excerpt: h.excerpt }))
  );
}
