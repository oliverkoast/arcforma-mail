import { ipcMain } from "electron";
import { createCategory, deleteCategory, listCategories, updateCategory, type Db } from "@arcforma/store";
import type { AiClient } from "../ai/client.js";
import { askInbox, draftReply, instantReplies, summarize } from "../ai/features.js";
import { refileThread } from "../classify/corrections.js";
import type { Classifier } from "../classify/pipeline.js";
import { emit } from "../events.js";
import { log } from "../log.js";
import { requireAccount } from "./guard.js";
import type { SyncManager } from "../sync.js";
import type { CategoryInfo, RefileTarget } from "../../shared/types.js";

export function categoryInfos(db: Db): CategoryInfo[] {
  return listCategories(db).map((c) => ({ id: c.id, name: c.name, kind: c.kind, prompt: c.prompt }));
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function registerAiIpc(db: Db, ai: AiClient, classifier: Classifier | null, sync: SyncManager): void {
  ipcMain.handle("ai:status", () => ai.status());
  ipcMain.handle("ai:summary", (_e, accountId: string, threadId: string) => summarize(db, ai, accountId, threadId));
  ipcMain.handle("ai:instantReplies", (_e, accountId: string, messageId: string) => instantReplies(db, ai, accountId, messageId));
  ipcMain.handle("ai:draftReply", (_e, accountId: string, threadId: string) => draftReply(db, ai, accountId, threadId));
  ipcMain.handle("ai:ask", (_e, question: string, accountIds?: string[]) => askInbox(db, ai, question, accountIds));

  ipcMain.handle("categories:create", (_e, name: string, prompt: string) => {
    const clean = name.trim();
    if (!clean) throw new Error("Give the category a name.");
    const base = slug(clean) || "category";
    const taken = new Set(listCategories(db).map((c) => c.id));
    let id = base;
    for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
    if (listCategories(db).some((c) => c.name.toLowerCase() === clean.toLowerCase())) throw new Error(`A category named ${clean} already exists.`);
    createCategory(db, { id, name: clean, prompt: prompt.trim() });
    const infos = categoryInfos(db);
    emit("categories:changed", infos);
    log("categories", `created ${id}; reclassifying the last 30 days`);
    classifier?.reclassifyRecent(30);
    return infos;
  });
  ipcMain.handle("categories:update", (_e, id: string, patch: { name?: string; prompt?: string }) => {
    updateCategory(db, id, { name: patch.name?.trim(), prompt: patch.prompt?.trim() });
    const infos = categoryInfos(db);
    emit("categories:changed", infos);
    return infos;
  });
  ipcMain.handle("categories:delete", (_e, id: string) => {
    deleteCategory(db, id);
    const infos = categoryInfos(db);
    emit("categories:changed", infos);
    return infos;
  });

  ipcMain.handle("classify:refile", (_e, accountId: string, threadId: string, to: RefileTarget) => {
    requireAccount(db, accountId);
    refileThread(db, accountId, threadId, to);
    sync.poke(accountId);
    emit("threads:changed", { accountId });
  });
}
