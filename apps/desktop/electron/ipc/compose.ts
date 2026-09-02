import { ipcMain } from "electron";
import { deleteSnippet, getSettings, listDrafts, listSnippets, saveDraft, setSetting, updateSnippet, upsertSnippet, type Db, type DraftRow } from "@arcforma/store";
import { queueSend, signatureFor, undoSend } from "../compose/queue.js";
import { detachDraftForSend, discardDraft, restoreDraft, type DraftMirror } from "../drafts/mirror.js";
import { emit } from "../events.js";
import { log } from "../log.js";
import type { Scheduler } from "../scheduler.js";
import type { SyncManager } from "../sync.js";
import type { Address, ComposeDraft, DraftInfo, SaveDraftOptions, SettingsInfo, SnippetInfo, UndoSendResult } from "../../shared/types.js";

export function toDraftInfo(row: DraftRow): DraftInfo {
  return {
    draftId: row.id,
    accountId: row.account_id,
    threadId: row.thread_id,
    mode: row.mode,
    to: JSON.parse(row.to_json) as Address[],
    cc: JSON.parse(row.cc_json) as Address[],
    bcc: JSON.parse(row.bcc_json) as Address[],
    subject: row.subject,
    bodyHtml: row.body_html,
    quotedHtml: row.quoted_html,
    inReplyTo: row.in_reply_to,
    references: row.references_header,
    updatedAt: row.updated_at,
    origin: row.origin,
    mirror: { state: row.mirror_state, error: row.mirror_error, at: row.mirrored_at },
  };
}

function snippets(db: Db): SnippetInfo[] {
  return listSnippets(db).map((s) => ({ id: s.id, trigger: s.trigger, name: s.name, bodyHtml: s.body_html, bodyText: s.body_text }));
}

export function registerComposeIpc(db: Db, scheduler: Scheduler, mirror: DraftMirror, sync: Pick<SyncManager, "poke">): void {
  ipcMain.handle("compose:send", async (_e, draft: ComposeDraft, sendAt?: number | null) => {
    // The local row leaves Drafts now; its Gmail draft goes once the send has succeeded.
    let gmailDraftId: string | null = null;
    if (draft.draftId) {
      mirror.cancel(draft.draftId);
      gmailDraftId = detachDraftForSend(db, draft.draftId);
    }
    const result = await queueSend(db, draft, { sendAt: sendAt ?? null, gmailDraftId });
    log("compose", `queued send ${result.id} for ${new Date(result.sendAt).toISOString()}`);
    scheduler.wakeSoon(result.sendAt);
    return result;
  });
  ipcMain.handle("compose:signature", (_e, accountId: string) => signatureFor(db, accountId));
  ipcMain.handle("send:undo", async (_e, id: number): Promise<UndoSendResult> => {
    const r = undoSend(db, id);
    if (!r.cancelled || !r.draft) return { cancelled: r.cancelled, draft: r.draft };
    // Back under Drafts, still the same Gmail draft, mirrored again with whatever comes next.
    const draftId = await restoreDraft(db, r.draft, r.gmailDraftId);
    sync.poke(r.draft.accountId);
    emit("drafts:changed", { accountId: r.draft.accountId });
    return { cancelled: true, draft: { ...r.draft, draftId } };
  });

  ipcMain.handle("drafts:save", (_e, draft: ComposeDraft, opts?: SaveDraftOptions) => {
    const id = saveDraft(db, {
      id: draft.draftId ?? null,
      accountId: draft.accountId,
      threadId: draft.threadId ?? null,
      mode: draft.mode,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      bodyHtml: draft.bodyHtml,
      quotedHtml: draft.quotedHtml,
      inReplyTo: draft.inReplyTo ?? null,
      references: draft.references ?? null,
    });
    mirror.touch(id, draft.accountId, Boolean(opts?.flush));
    return id;
  });
  ipcMain.handle("drafts:list", (_e, accountIds?: string[]) => listDrafts(db, accountIds).map(toDraftInfo));
  ipcMain.handle("drafts:delete", (_e, id: number) => {
    mirror.cancel(id);
    const r = discardDraft(db, id);
    if (r?.queued) sync.poke(r.accountId);
  });

  ipcMain.handle("snippets:list", () => snippets(db));
  ipcMain.handle("snippets:save", (_e, s: { id?: number | null; trigger: string; name: string; bodyHtml: string; bodyText: string }) => {
    const trigger = s.trigger.trim().replace(/^;/, "").toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(trigger)) throw new Error("Triggers are 1 to 32 letters, digits, dashes, or underscores.");
    if (s.id) updateSnippet(db, s.id, { trigger, name: s.name.trim() || trigger, bodyHtml: s.bodyHtml, bodyText: s.bodyText });
    else upsertSnippet(db, { trigger, name: s.name.trim() || trigger, bodyHtml: s.bodyHtml, bodyText: s.bodyText });
    return snippets(db);
  });
  ipcMain.handle("snippets:delete", (_e, id: number) => {
    deleteSnippet(db, id);
    return snippets(db);
  });

  ipcMain.handle("settings:get", (): SettingsInfo => getSettings(db));
  ipcMain.handle("settings:set", (_e, patch: Partial<SettingsInfo>): SettingsInfo => {
    if (typeof patch.undoWindowSec === "number") setSetting(db, "undoWindowSec", Math.max(0, Math.min(60, Math.round(patch.undoWindowSec))));
    if (typeof patch.autoDraft === "boolean") setSetting(db, "autoDraft", patch.autoDraft);
    if (patch.remoteImages === "always" || patch.remoteImages === "known" || patch.remoteImages === "never") setSetting(db, "remoteImages", patch.remoteImages);
    if (typeof patch.remindClientsAfterDays === "number" && Number.isFinite(patch.remindClientsAfterDays)) setSetting(db, "remindClientsAfterDays", Math.max(0, Math.min(60, Math.round(patch.remindClientsAfterDays))));
    if (Array.isArray(patch.remindScope)) setSetting(db, "remindScope", patch.remindScope.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean));
    const next = getSettings(db);
    emit("toast", { text: "Settings saved." });
    return next;
  });
}
