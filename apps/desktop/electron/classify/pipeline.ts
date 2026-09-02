// The background classifier. Rules first, local model for the residue, one
// thread at a time so the llama-server child is never asked for parallel work.
// Never touches Claude. Idle when the daemon is down; retries on the next poke.

import { getSetting, setSetting } from "@arcforma/store";
import { getBody, listCategories, listThreadMessages, recentThreads, repliedDomains, threadsNeedingClassification, upsertClassification, changeThreadLabels, type Db } from "@arcforma/store";
import { AiError, type AiClient } from "../ai/client.js";
import { emit } from "../events.js";
import { log, logError } from "../log.js";
import { labelForCategory, threadExcerpt } from "./corrections.js";
import { classifyLocally } from "./local.js";
import { classifyByRules, pickDecidingMessage, ruleInputFromRow } from "./rules.js";

export interface ClassifyOutcome {
  split: "important" | "other";
  type: string | null;
  categoryId: string | null;
  confidence: number;
  source: "rule" | "local";
}

/** Rules, then the local model. Throws AiError when the model is needed and unavailable. */
export async function classifyThread(db: Db, ai: AiClient, accountId: string, threadId: string, ctx: { repliedDomains: Set<string>; ownerAddresses: Set<string> }): Promise<ClassifyOutcome | null> {
  const messages = listThreadMessages(db, accountId, threadId);
  const deciding = pickDecidingMessage(messages);
  if (!deciding) return null;
  const body = getBody(db, accountId, deciding.id);
  const verdict = classifyByRules(ruleInputFromRow(deciding, body?.attachments_json), ctx);
  if (verdict.split) {
    return { split: verdict.split, type: verdict.type, categoryId: null, confidence: 1, source: "rule" };
  }
  const { excerpt } = threadExcerpt(db, accountId, threadId);
  const local = await classifyLocally(db, ai, excerpt);
  return { split: local.split, type: local.type, categoryId: local.categoryId, confidence: local.confidence, source: "local" };
}

/** Bump when a rule changes meaning, so stored rule verdicts get re-evaluated once. */
const RULES_VERSION = 2;

export class Classifier {
  private running = false;
  private queued = false;
  private stopped = false;
  private pausedUntil = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly ai: AiClient,
    private readonly ownerAddresses: () => string[],
    private readonly onChanged: (accountIds: Set<string>) => void
  ) {}

  start(): void {
    this.reclassifyAfterRuleChange();
    this.timer = setInterval(() => this.poke(), 60_000);
    this.poke();
  }

  /**
   * When the deterministic rules change, verdicts they produced are stale. Drop the affected
   * rule-sourced rows so the next pass re-decides them; model verdicts and corrections stay.
   */
  private reclassifyAfterRuleChange(): void {
    if (getSetting(this.db, "rulesVersion") >= RULES_VERSION) return;
    const n = this.db.prepare("DELETE FROM classifications WHERE source = 'rule' AND type = 'calendar'").run().changes;
    setSetting(this.db, "rulesVersion", RULES_VERSION);
    log("classify", `rules v${RULES_VERSION}: reset ${n} calendar verdicts for re-evaluation`);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs a pass soon. Safe to call often; a pass already running picks the new work up. */
  poke(): void {
    if (this.stopped) return;
    if (this.running) {
      this.queued = true;
      return;
    }
    void this.run();
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      do {
        this.queued = false;
        if (Date.now() < this.pausedUntil) break;
        await this.pass();
      } while (this.queued && !this.stopped);
    } finally {
      this.running = false;
    }
  }

  private async pass(): Promise<void> {
    const work = threadsNeedingClassification(this.db, { limit: 40 });
    if (work.length === 0) return;
    const ctx = { repliedDomains: repliedDomains(this.db, 90), ownerAddresses: new Set(this.ownerAddresses().map((a) => a.toLowerCase())) };
    const touched = new Set<string>();
    let modelDown = false;
    for (const t of work) {
      if (this.stopped) break;
      try {
        const out = await classifyThread(this.db, this.ai, t.account_id, t.id, ctx);
        if (!out) continue;
        const last = listThreadMessages(this.db, t.account_id, t.id).at(-1);
        upsertClassification(this.db, { accountId: t.account_id, threadId: t.id, split: out.split, type: out.type, categoryId: out.categoryId, confidence: out.confidence, source: out.source, lastMessageId: last?.id ?? null });
        touched.add(t.account_id);
      } catch (err) {
        if (err instanceof AiError) {
          // The daemon or model is away: stop this pass, try again in a few minutes.
          modelDown = true;
          this.pausedUntil = Date.now() + 3 * 60_000;
          log("classify", `paused: ${err.code} ${err.message}`);
          break;
        }
        logError("classify", `${t.account_id}/${t.id}`, err);
      }
    }
    if (touched.size) {
      log("classify", `classified ${touched.size ? work.length : 0} thread(s)${modelDown ? " before the model went away" : ""}`);
      this.onChanged(touched);
    }
  }

  /** After a custom category is added: reclassify the last 30 days in the background and apply category labels. */
  reclassifyRecent(days = 30): void {
    if (this.stopped) return;
    const threads = recentThreads(this.db, days);
    log("classify", `reclassifying ${threads.length} thread(s) from the last ${days} days`);
    void (async () => {
      const ctx = { repliedDomains: repliedDomains(this.db, 90), ownerAddresses: new Set(this.ownerAddresses().map((a) => a.toLowerCase())) };
      const categories = listCategories(this.db);
      const touched = new Set<string>();
      let done = 0;
      for (const t of threads) {
        if (this.stopped) break;
        try {
          const out = await classifyThread(this.db, this.ai, t.account_id, t.id, ctx);
          if (!out) continue;
          const last = listThreadMessages(this.db, t.account_id, t.id).at(-1);
          upsertClassification(this.db, { accountId: t.account_id, threadId: t.id, split: out.split, type: out.type, categoryId: out.categoryId, confidence: out.confidence, source: out.source, lastMessageId: last?.id ?? null });
          const label = labelForCategory(categories, out.categoryId);
          if (label) changeThreadLabels(this.db, t.account_id, t.id, { addNames: [label] });
          touched.add(t.account_id);
          done += 1;
          if (done % 25 === 0) this.onChanged(touched);
        } catch (err) {
          if (err instanceof AiError) {
            log("classify", `reclassify stopped after ${done}: ${err.code}`);
            emit("toast", { eyebrow: "CLASSIFIER PAUSED", text: err.code === "daemon_down" ? "The AI daemon is not running." : err.message });
            break;
          }
          logError("classify", `reclassify ${t.account_id}/${t.id}`, err);
        }
      }
      if (touched.size) this.onChanged(touched);
      log("classify", `reclassify done: ${done} of ${threads.length}`);
    })();
  }
}
