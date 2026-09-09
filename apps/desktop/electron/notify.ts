import { Notification } from "electron";
import { getThread, listThreadMessages, getSetting, type Db } from "@arcforma/store";
import { shouldBanner } from "./notify-rule.js";
import { emit } from "./events.js";
import { log } from "./log.js";

/**
 * macOS banners for new Important and calendar mail.
 *
 * Asked once by the sync after a thread is fetched, and once by the classifier after it decides a
 * thread is important, because those are the two moments a message can become worth announcing:
 * a thread that was already important gets its banner at fetch time, a new thread gets it the
 * moment the classifier says so. Each message is announced at most once, and only messages that
 * arrived after this process started are considered, so a launch never replays the morning.
 */
export class Notifier {
  private readonly seen = new Set<string>();
  private readonly startedAt = Date.now();
  constructor(private readonly db: Db, private readonly opts: { smoke: boolean; focus: () => void }) {}

  consider(accountId: string, threadId: string): void {
    if (!Notification.isSupported()) return;
    const thread = getThread(this.db, accountId, threadId);
    if (!thread) return;
    const messages = listThreadMessages(this.db, accountId, threadId);
    const newest = messages.filter((m) => m.direction === "in").sort((a, b) => b.internal_date - a.internal_date)[0];
    if (!newest) return;
    const key = `${accountId}:${newest.id}`;
    const ok = shouldBanner({
      enabled: getSetting(this.db, "notifyBanners") === true,
      smoke: this.opts.smoke,
      split: (thread as { split?: string | null }).split ?? null,
      type: (thread as { type?: string | null }).type ?? null,
      direction: newest.direction,
      internalDate: newest.internal_date,
      startedAt: this.startedAt,
      seen: this.seen.has(key),
    });
    if (!ok) return;
    this.seen.add(key);
    const who = (newest.from_name || newest.from_email || "").trim();
    const n = new Notification({ title: who || thread.subject || "New mail", body: who ? thread.subject || "(no subject)" : "", silent: false });
    n.on("click", () => {
      this.opts.focus();
      emit("notify:open", { accountId, threadId });
    });
    n.show();
    log("notify", `banner for ${accountId}/${threadId}`);
  }
}
