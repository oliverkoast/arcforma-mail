// U on a thread. Reads the List-Unsubscribe headers of the newest inbound
// message, runs the best method the sender offers, records what happened,
// and archives the thread when the request actually went out:
//
//   one-click  POST List-Unsubscribe=One-Click to the https URL (RFC 8058)
//   mailto     a bare message through the send queue, out on the next tick
//   open       the page in the default browser; the user finishes there
//
// A one-click POST that fails falls back to the next method rather than
// stopping, so the toast always says what was done.

import { bestUnsubscribeMethod, buildUnsubscribeMessage, fetchTransport, parseListUnsubscribe, postOneClick, type Transport, type UnsubscribeMethod } from "@arcforma/gmail";
import { archive, enqueueSend, getAccount, setUnsubscribeState, unsubscribeSource, type Db, type UnsubscribeState } from "@arcforma/store";
import { log, logError } from "./log.js";

export interface UnsubscribeDeps {
  /** The one-click POST goes through this; tests inject one. */
  transport?: Transport;
  /** Opens the unsubscribe page; Electron hands in shell.openExternal. */
  openExternal: (url: string) => Promise<void> | void;
  now?: number;
}

export interface UnsubscribeOutcome {
  method: UnsubscribeMethod | "none";
  ok: boolean;
  archived: boolean;
  state: UnsubscribeState;
  text: string;
  /** The send_queue row a mailto request was queued as, so the caller can wake the scheduler. */
  sendId: number | null;
  /** Who the toast names. */
  sender: string;
}

/** The name the toast uses: the display name, else the list, else the sender's domain. */
export function senderLabel(src: { fromName: string; fromEmail: string; listId: string | null }): string {
  if (src.fromName.trim()) return src.fromName.trim();
  const list = (src.listId ?? "").replace(/^<|>$/g, "").trim();
  if (list) return list.split(".")[0] || list;
  return src.fromEmail.split("@")[1] || src.fromEmail;
}

export async function unsubscribeThread(db: Db, accountId: string, threadId: string, deps: UnsubscribeDeps): Promise<UnsubscribeOutcome> {
  const now = deps.now ?? Date.now();
  const src = unsubscribeSource(db, accountId, threadId);
  if (!src) {
    return { method: "none", ok: false, archived: false, state: "none", text: "No unsubscribe link in this thread.", sendId: null, sender: "" };
  }
  const sender = senderLabel(src);
  const targets = parseListUnsubscribe(src.listUnsubscribe, src.listUnsubscribePost);
  let method = bestUnsubscribeMethod(targets);
  if (!method) {
    setUnsubscribeState(db, accountId, threadId, { state: "failed", error: "No usable target in List-Unsubscribe." }, now);
    return { method: "none", ok: false, archived: false, state: "failed", text: `${sender} offers no unsubscribe link this app can use.`, sendId: null, sender };
  }

  if (method === "one-click") {
    try {
      await postOneClick(targets.oneClick!, deps.transport ?? fetchTransport);
      setUnsubscribeState(db, accountId, threadId, { state: "sent", method, target: targets.oneClick }, now);
      archive(db, accountId, threadId);
      log("unsubscribe", `${accountId}/${threadId} one-click to ${targets.oneClick}`);
      return { method, ok: true, archived: true, state: "sent", text: `Unsubscribed from ${sender} and archived.`, sendId: null, sender };
    } catch (err) {
      logError("unsubscribe", `${accountId}/${threadId} one-click`, err);
      // The POST did not land. The mailto or the page still can.
      method = targets.mailto ? "mailto" : "open";
    }
  }

  if (method === "mailto") {
    const account = getAccount(db, accountId);
    if (!account) throw new Error(`Unknown account ${accountId}.`);
    try {
      const built = await buildUnsubscribeMessage({ email: account.email, name: account.display_name ?? "" }, targets.mailto!);
      const row = enqueueSend(db, { accountId, threadId: null, rawMime: built.mime, sendAt: now, undoUntil: now, meta: { unsubscribe: { threadId, to: targets.mailto!.to } } });
      setUnsubscribeState(db, accountId, threadId, { state: "sent", method, target: `mailto:${targets.mailto!.to}` }, now);
      archive(db, accountId, threadId);
      log("unsubscribe", `${accountId}/${threadId} mailto ${targets.mailto!.to} queued as send ${row.id}`);
      return { method, ok: true, archived: true, state: "sent", text: `Unsubscribed from ${sender} and archived.`, sendId: row.id, sender };
    } catch (err) {
      logError("unsubscribe", `${accountId}/${threadId} mailto`, err);
      if (!targets.url) {
        setUnsubscribeState(db, accountId, threadId, { state: "failed", method, target: `mailto:${targets.mailto!.to}`, error: (err as Error).message }, now);
        return { method, ok: false, archived: false, state: "failed", text: `Could not unsubscribe from ${sender}: ${(err as Error).message}`, sendId: null, sender };
      }
      method = "open";
    }
  }

  try {
    await deps.openExternal(targets.url!);
    setUnsubscribeState(db, accountId, threadId, { state: "opened", method: "open", target: targets.url }, now);
    log("unsubscribe", `${accountId}/${threadId} opened ${targets.url}`);
    return { method: "open", ok: true, archived: false, state: "opened", text: "Opened the unsubscribe page.", sendId: null, sender };
  } catch (err) {
    logError("unsubscribe", `${accountId}/${threadId} open`, err);
    setUnsubscribeState(db, accountId, threadId, { state: "failed", method: "open", target: targets.url, error: (err as Error).message }, now);
    return { method: "open", ok: false, archived: false, state: "failed", text: `Could not open the unsubscribe page for ${sender}.`, sendId: null, sender };
  }
}
