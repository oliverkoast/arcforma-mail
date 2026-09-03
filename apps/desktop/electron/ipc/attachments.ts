// Preview, Download, and Save as for one attachment.
//
// Every handler takes the same three strings from the renderer: an account, a
// message, and an attachment key. None of them takes a path, a filename, or a
// Gmail attachment id, so the renderer cannot ask for a file that is not a part
// of a message the store already holds. The account is checked against the
// store, the message is checked against the account, and the key is resolved
// against that message's stored parts before anything is fetched.
//
// The bytes land in the cache folder under a name this app made up, at mode
// 0600. Download copies that file into the person's Downloads folder under a
// name nothing there has and reveals it in Finder. Save as does the same to a
// folder they pick. Preview opens a window that renders images, PDFs, and text
// and nothing else. There is no "Open with default app": handing a file a
// stranger sent to whatever the system associates with its extension is the one
// move this feature will not make. A person who wants that saves the file and
// opens it themselves, which is a decision with their hand on it.

import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";
import { getMessage, type Db } from "@arcforma/store";
import type { AccountRegistry } from "../accounts.js";
import { emit } from "../events.js";
import { logError } from "../log.js";
import { requireAccount, requireId } from "./guard.js";
import { attachmentsRoot, resolveInRoot, safeFilename } from "../attachments/paths.js";
import { nonClobberingPath, readCached, type CachedAttachment } from "../attachments/cache.js";
import { MAX_TEXT_PREVIEW, previewKind } from "../attachments/kind.js";
import { ensureCached, fetchErrorText, findPart, type FoundPart } from "../attachments/service.js";
import { openPreviewWindow } from "../attachments/window.js";
import { attachmentSrc } from "../attachments/route.js";
import { bytesLabel } from "../attachments/label.js";
import type { AttachmentDetail, AttachmentSaveResult } from "../../shared/types.js";

export interface AttachmentIpcOptions {
  /** Directory holding preload.cjs, handed to the preview window. */
  electronDir: string;
  devUrl?: string | undefined;
  /** Where the cache lives. Defaults to <userData>/attachments. */
  root?: string;
}

export function registerAttachmentIpc(db: Db, accounts: AccountRegistry, opts: AttachmentIpcOptions): void {
  const root = opts.root ?? attachmentsRoot(app.getPath("userData"));

  /** Resolves and checks the three strings the renderer sent. Throws with a sentence a toast can show. */
  function resolve(accountId: unknown, messageId: unknown, key: unknown): { accountId: string; messageId: string; found: FoundPart } {
    requireAccount(db, accountId);
    const a = accountId as string;
    const m = requireId(messageId, "message");
    const k = requireId(key, "attachment");
    if (!getMessage(db, a, m)) throw new Error("That message is no longer in the local store.");
    const found = findPart(db, a, m, k);
    if (!found) throw new Error("That attachment is not on this message any more.");
    return { accountId: a, messageId: m, found };
  }

  /** The cached file, fetching it first when it is not there. Over a megabyte the wait is reported in a toast. */
  async function bytesFor(accountId: string, messageId: string, found: FoundPart): Promise<CachedAttachment> {
    try {
      const { file } = await ensureCached(
        {
          db,
          root,
          client: accounts.client(accountId),
          onProgress: (state) => {
            if (state.phase === "fetching") emit("toast", { eyebrow: "FETCHING", text: `${found.part.filename}, ${bytesLabel(state.bytes)}` });
          },
        },
        accountId,
        messageId,
        found
      );
      return file;
    } catch (err) {
      logError("attachments", `${accountId}/${messageId}/${found.key}`, err);
      // Never silent: the reason reaches the renderer, which shows it in a toast.
      throw new Error(fetchErrorText(err));
    }
  }

  ipcMain.handle("attachments:preview", async (_e, accountId: string, messageId: string, key: string): Promise<void> => {
    const target = resolve(accountId, messageId, key);
    // The bytes are cached before the window opens, so the window itself never
    // waits on the network and never needs a client of its own.
    await bytesFor(target.accountId, target.messageId, target.found);
    openPreviewWindow({
      accountId: target.accountId,
      messageId: target.messageId,
      key: target.found.key,
      kind: target.found.kind,
      filename: safeFilename(target.found.part.filename),
      electronDir: opts.electronDir,
      devUrl: opts.devUrl,
    });
  });

  ipcMain.handle("attachments:download", async (_e, accountId: string, messageId: string, key: string): Promise<AttachmentSaveResult> => {
    const target = resolve(accountId, messageId, key);
    const file = await bytesFor(target.accountId, target.messageId, target.found);
    const downloads = app.getPath("downloads");
    fs.mkdirSync(downloads, { recursive: true });
    const dest = nonClobberingPath(downloads, file.filename);
    // The source is inside the cache root and the name of the copy was rebuilt
    // by safeFilename, so neither end of this copy came off the network.
    fs.copyFileSync(resolveInRoot(root, file.path), dest);
    shell.showItemInFolder(dest);
    return { saved: true, path: dest, filename: path.basename(dest) };
  });

  ipcMain.handle("attachments:saveAs", async (_e, accountId: string, messageId: string, key: string): Promise<AttachmentSaveResult> => {
    const target = resolve(accountId, messageId, key);
    const file = await bytesFor(target.accountId, target.messageId, target.found);
    const parent = BrowserWindow.getFocusedWindow();
    const defaultPath = path.join(app.getPath("downloads"), safeFilename(file.filename));
    const result = parent
      ? await dialog.showSaveDialog(parent, { defaultPath, title: "Save attachment" })
      : await dialog.showSaveDialog({ defaultPath, title: "Save attachment" });
    if (result.canceled || !result.filePath) return { saved: false, path: null, filename: null };
    fs.copyFileSync(resolveInRoot(root, file.path), result.filePath);
    return { saved: true, path: result.filePath, filename: path.basename(result.filePath) };
  });

  // The preview window asks for this once it has loaded. It only ever answers
  // for an attachment already in the cache, so this handler never fetches.
  ipcMain.handle("attachments:detail", (_e, accountId: string, messageId: string, key: string): AttachmentDetail => {
    const target = resolve(accountId, messageId, key);
    const cached = readCached(db, root, target.accountId, target.messageId, target.found.key);
    if (!cached) throw new Error("That attachment is not on this machine.");
    const kind = previewKind(cached.mimeType, cached.filename);
    const message = getMessage(db, target.accountId, target.messageId);
    let text: string | null = null;
    let truncated = false;
    if (kind === "text") {
      const full = resolveInRoot(root, cached.path);
      // Only the first MAX_TEXT_PREVIEW bytes are ever read, through a handle
      // rather than readFileSync, so a huge log file cannot pull itself into
      // memory whole just because someone clicked its chip.
      const handle = fs.openSync(full, "r");
      try {
        const buf = Buffer.alloc(MAX_TEXT_PREVIEW);
        const read = fs.readSync(handle, buf, 0, MAX_TEXT_PREVIEW, 0);
        truncated = fs.fstatSync(handle).size > read;
        // Shown as text in a <pre>. It is never parsed as markup and never
        // evaluated, whatever the file claims to be.
        text = buf.subarray(0, read).toString("utf8");
      } finally {
        fs.closeSync(handle);
      }
    }
    return {
      accountId: target.accountId,
      messageId: target.messageId,
      key: target.found.key,
      filename: cached.filename,
      mimeType: cached.mimeType,
      size: cached.bytes,
      kind,
      src: kind === "image" || kind === "pdf" ? attachmentSrc(target.accountId, target.messageId, target.found.key) : null,
      text,
      truncated,
      subject: message?.subject ?? "",
      from: message?.from_email ?? "",
    };
  });
}
