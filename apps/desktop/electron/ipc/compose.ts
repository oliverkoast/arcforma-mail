import { dialog, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { deleteSnippet, getSettings, hasReceiptAuthToken, listDrafts, listSnippets, saveDraft, setReceiptAuthToken, setSetting, updateSnippet, upsertSnippet, type Db, type DraftRow } from "@arcforma/store";
import { signatureFor, undoSend } from "../compose/queue.js";
import { discardDraft, restoreDraft, sendDraft, type DraftMirror } from "../drafts/mirror.js";
import { emit } from "../events.js";
import { log, logError } from "../log.js";
import { normaliseServiceUrl } from "../receipts/pixel.js";
import type { ReceiptArmer } from "../receipts/arm.js";
import type { ReceiptService } from "../receipts/service.js";
import type { Scheduler } from "../scheduler.js";
import type { SyncManager } from "../sync.js";
import type { Address, ComposeDraft, DraftInfo, ReceiptCheckResult, SaveDraftOptions, SettingsInfo, SnippetInfo, UndoSendResult, OutgoingAttachmentInfo } from "../../shared/types.js";

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
    readReceipt: row.read_receipt === 1,
    attachments: filesOf(row.attachments_json),
    origin: row.origin,
    mirror: { state: row.mirror_state, error: row.mirror_error, at: row.mirrored_at },
  };
}

/**
 * The settings the renderer is allowed to see, listed one by one rather than
 * handed the store's whole row. The pixel service token is stored beside these
 * and must never come back out, so nothing here may be a spread of getSettings.
 */
export function settingsInfo(db: Db): SettingsInfo {
  const s = getSettings(db);
  return {
    undoWindowSec: s.undoWindowSec,
    autoDraft: s.autoDraft,
    remoteImages: s.remoteImages,
    remindClientsAfterDays: s.remindClientsAfterDays,
    remindScope: s.remindScope,
    readReceipts: s.readReceipts,
    readReceiptsUrl: s.readReceiptsUrl,
    readReceiptsTokenSet: hasReceiptAuthToken(db),
  };
}

/**
 * The store file holds the pixel service token from now on, so it is tightened
 * to owner-only the way tokens.json and oauth-clients.json are. The write-ahead
 * files carry the same rows before a checkpoint, so they are tightened too.
 */
function tightenStoreFile(file: string | null): void {
  if (!file) return;
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
    } catch (err) {
      logError("receipts", `tighten ${f}`, err);
    }
  }
}

function snippets(db: Db): SnippetInfo[] {
  return listSnippets(db).map((s) => ({ id: s.id, trigger: s.trigger, name: s.name, bodyHtml: s.body_html, bodyText: s.body_text }));
}

export interface ComposeIpcReceipts {
  armer: ReceiptArmer;
  service: Pick<ReceiptService, "check">;
  /** The store file, tightened to 0600 when the service token is written into it. */
  storePath: string | null;
}

export function registerComposeIpc(db: Db, scheduler: Scheduler, mirror: DraftMirror, sync: Pick<SyncManager, "poke">, receipts?: ComposeIpcReceipts): void {
  ipcMain.handle("compose:send", async (_e, draft: ComposeDraft, sendAt?: number | null) => {
    // Checked first, then the local row leaves Drafts; its Gmail draft goes once the send has succeeded.
    const result = await sendDraft(db, draft, { sendAt: sendAt ?? null, cancelMirror: (id) => mirror.cancel(id), ...(receipts ? { receipts: receipts.armer } : {}) });
    log("compose", `queued send ${result.id} for ${new Date(result.sendAt).toISOString()}${result.receipt.requested ? `, receipt ${result.receipt.armed ? "armed" : `not armed: ${result.receipt.problem ?? "unknown"}`}` : ""}`);
    scheduler.wakeSoon(result.sendAt);
    return result;
  });
  ipcMain.handle("compose:pickFiles", async (): Promise<OutgoingAttachmentInfo[]> => {
    const picked = await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"], buttonLabel: "Attach" });
    if (picked.canceled) return [];
    const out: OutgoingAttachmentInfo[] = [];
    for (const file of picked.filePaths) {
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) continue;
        out.push({ path: file, name: path.basename(file), size: stat.size, mimeType: mimeOf(file) });
      } catch (err) {
        // A file that cannot be read is not attached, and the others still are.
        logError("compose", `could not read ${path.basename(file)}`, err);
      }
    }
    return out;
  });
  // Only a path this draft is actually carrying may be opened, so a renderer bug cannot turn these
  // into a way to open any file on the machine.
  const inDraft = (p: unknown): p is string => typeof p === "string" && draftPaths(db).has(p);
  ipcMain.handle("compose:openFile", async (_e, filePath: unknown): Promise<string | null> => {
    if (!inDraft(filePath)) return "That file is not attached to a draft.";
    const problem = await shell.openPath(filePath);
    return problem || null;
  });
  ipcMain.handle("compose:revealFile", (_e, filePath: unknown): void => {
    if (inDraft(filePath)) shell.showItemInFolder(filePath);
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
      readReceipt: draft.readReceipt === true,
      attachments: draft.attachments ?? [],
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

  ipcMain.handle("settings:get", (): SettingsInfo => settingsInfo(db));
  ipcMain.handle("settings:set", (_e, patch: Partial<SettingsInfo>): SettingsInfo => {
    if (typeof patch.undoWindowSec === "number") setSetting(db, "undoWindowSec", Math.max(0, Math.min(60, Math.round(patch.undoWindowSec))));
    if (typeof patch.autoDraft === "boolean") setSetting(db, "autoDraft", patch.autoDraft);
    if (patch.remoteImages === "always" || patch.remoteImages === "known" || patch.remoteImages === "never") setSetting(db, "remoteImages", patch.remoteImages);
    if (typeof patch.remindClientsAfterDays === "number" && Number.isFinite(patch.remindClientsAfterDays)) setSetting(db, "remindClientsAfterDays", Math.max(0, Math.min(60, Math.round(patch.remindClientsAfterDays))));
    if (Array.isArray(patch.remindScope)) setSetting(db, "remindScope", patch.remindScope.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean));
    if (typeof patch.readReceipts === "boolean") setSetting(db, "readReceipts", patch.readReceipts);
    if (typeof patch.readReceiptsUrl === "string") setSetting(db, "readReceiptsUrl", receiptUrl(patch.readReceiptsUrl));
    const next = settingsInfo(db);
    emit("toast", { text: "Settings saved." });
    return next;
  });

  // Write only. The token goes in and the answer says whether one is stored,
  // never what it is: nothing in this app reads it back to the renderer.
  ipcMain.handle("receipts:setToken", (_e, token: unknown): SettingsInfo => {
    if (typeof token !== "string") throw new Error("A token is text.");
    setReceiptAuthToken(db, token.trim());
    tightenStoreFile(receipts?.storePath ?? null);
    emit("toast", { text: token.trim() ? "Pixel service token saved." : "Pixel service token cleared." });
    return settingsInfo(db);
  });

  ipcMain.handle("receipts:check", async (): Promise<ReceiptCheckResult> => {
    if (!receipts) return { ok: false, text: "Read receipts are not wired up in this run." };
    return receipts.service.check();
  });
}

/** Only http and https reach a recipient's client, and anything else here would be a URL that silently never loads. */
export function receiptUrl(raw: string): string {
  const url = normaliseServiceUrl(raw);
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) throw new Error("The pixel service address starts with https:// or http://.");
  return url;
}

/** A stored attachment list, or none. A draft written before schema 18 simply has no files. */
function filesOf(json: string | null | undefined): OutgoingAttachmentInfo[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as OutgoingAttachmentInfo[];
    return Array.isArray(parsed) ? parsed.filter((f) => typeof f?.path === "string" && typeof f?.name === "string") : [];
  } catch {
    return [];
  }
}

/** Every path any saved draft is carrying, plus the compose being edited, which saves as it is typed. */
function draftPaths(db: Db): Set<string> {
  const rows = db.prepare("SELECT attachments_json FROM drafts").all() as Array<{ attachments_json: string | null }>;
  const out = new Set<string>();
  for (const row of rows) {
    try {
      for (const f of JSON.parse(row.attachments_json ?? "[]") as Array<{ path?: unknown }>) {
        if (typeof f.path === "string") out.add(f.path);
      }
    } catch {
      // A draft with unreadable attachment JSON simply contributes nothing.
    }
  }
  return out;
}

/** Enough of a guess for the part header; the recipient's client decides what to do with it anyway. */
function mimeOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const known: Record<string, string> = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".ics": "text/calendar",
    ".zip": "application/zip",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return known[ext] ?? "application/octet-stream";
}
