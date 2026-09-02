// The background classifier. Rules first, local model for the residue, one
// thread at a time so the llama-server child is never asked for parallel work.
// Never touches Claude. Idle when the daemon is down; retries on the next poke.

import { getSetting, setSetting } from "@arcforma/store";
import {
  attentionContext,
  attentionFactsFor,
  getBody,
  listCategories,
  listThreadMessages,
  recentThreads,
  repliedTo,
  threadsNeedingClassification,
  updateAttention,
  upsertClassification,
  changeThreadLabels,
  type AttentionBand,
  type AttentionContext,
  type Db,
} from "@arcforma/store";
import { AiError, type AiClient } from "../ai/client.js";
import { emit } from "../events.js";
import { log, logError } from "../log.js";
import { scoreAttention, splitForBand } from "./attention.js";
import { labelForCategory, threadExcerpt } from "./corrections.js";
import { classifyLocally } from "./local.js";
import { classifyByRules, pickDecidingMessage, ruleInputFromRow } from "./rules.js";

export interface ClassifyOutcome {
  split: "important" | "other";
  type: string | null;
  categoryId: string | null;
  confidence: number;
  source: "rule" | "local";
  /** 0 to 100 from the attention model. */
  attention: number;
  band: AttentionBand;
  /** One sentence saying why the thread landed in its band. */
  reason: string;
}

/** What both passes need to run the rules. Built once per pass, because each half is a full table scan. */
export interface ClassifyContext {
  repliedDomains: Set<string>;
  repliedAddresses: Set<string>;
  ownerAddresses: Set<string>;
  /** The shared half of the attention model: who he writes to, sender volume, archive behaviour, re-files. */
  attention: AttentionContext;
}

/**
 * The attention half, for a thread whose type is already decided. The split
 * follows the band, so needs_you and important both read as Important
 * everywhere the split column is used. modelSaidImportant is only consulted
 * inside the grey zone; see classify/attention.ts.
 */
export function attentionFor(
  db: Db,
  accountId: string,
  threadId: string,
  ctx: ClassifyContext,
  opts: { type: string | null; modelSaidImportant?: boolean }
): { split: "important" | "other"; attention: number; band: AttentionBand; reason: string } | null {
  const facts = attentionFactsFor(db, accountId, threadId, ctx.attention, { type: opts.type });
  if (!facts) return null;
  const verdict = scoreAttention(facts, { modelSaidImportant: opts.modelSaidImportant });
  return { split: splitForBand(verdict.band), attention: verdict.score, band: verdict.band, reason: verdict.reason };
}

/**
 * The deterministic half: the mailbox type from the header rules, then the
 * attention model over it. Null when the rules cannot type the thread and the
 * model has to look; the type is what the model is for, not the split.
 */
export function ruleVerdictFor(db: Db, accountId: string, threadId: string, ctx: ClassifyContext): ClassifyOutcome | null {
  const messages = listThreadMessages(db, accountId, threadId);
  const deciding = pickDecidingMessage(messages);
  if (!deciding) return null;
  const body = getBody(db, accountId, deciding.id);
  const hasOutbound = messages.some((m) => m.direction === "out");
  const verdict = classifyByRules(ruleInputFromRow(deciding, body?.attachments_json, hasOutbound), ctx);
  if (!verdict.split) return null;
  const attention = attentionFor(db, accountId, threadId, ctx, { type: verdict.type });
  if (!attention) return null;
  return { split: attention.split, type: verdict.type, categoryId: null, confidence: 1, source: "rule", attention: attention.attention, band: attention.band, reason: attention.reason };
}

/** Rules, then the local model for the type it could not name. Throws AiError when the model is needed and unavailable. */
export async function classifyThread(db: Db, ai: AiClient, accountId: string, threadId: string, ctx: ClassifyContext): Promise<ClassifyOutcome | null> {
  if (listThreadMessages(db, accountId, threadId).length === 0) return null;
  const byRules = ruleVerdictFor(db, accountId, threadId, ctx);
  if (byRules) return byRules;
  const { excerpt } = threadExcerpt(db, accountId, threadId);
  const local = await classifyLocally(db, ai, excerpt);
  const attention = attentionFor(db, accountId, threadId, ctx, { type: local.type, modelSaidImportant: local.split === "important" });
  if (!attention) return null;
  return {
    split: attention.split,
    type: local.type,
    categoryId: local.categoryId,
    confidence: local.confidence,
    source: "local",
    attention: attention.attention,
    band: attention.band,
    reason: attention.reason,
  };
}

/** Bump when a rule changes meaning, so stored rule verdicts get re-evaluated once. */
const RULES_VERSION = 3;

/**
 * Bump when the attention weights or the bands change. Unlike the rules
 * version, this does not throw verdicts away: the sweep rescores every thread
 * that already has one, in place, leaving the type and the category alone. A
 * re-file keeps its split, because that one was the user's answer, not a guess.
 */
const ATTENTION_VERSION = 1;

/** Threads per batch. Small enough that a batch of rules work never holds the main process for long. */
const SWEEP_BATCH = 200;

/** Hands the main process back to the event loop between batches, so the window keeps painting. */
function yieldToLoop(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

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
    const reset = this.reclassifyAfterRuleChange();
    const rescore = getSetting(this.db, "attentionVersion") < ATTENTION_VERSION;
    this.timer = setInterval(() => this.poke(), 60_000);
    // The attention sweep runs after the rules sweep, never beside it: a thread whose type is about
    // to change would otherwise be scored against the type it is losing.
    void (async () => {
      if (reset > 0) await this.sweepRules();
      else if (!rescore) this.poke();
      if (rescore) {
        await this.sweepAttention();
        this.poke();
      }
    })();
  }

  /**
   * Scores every thread that already carries a verdict, so a weight change
   * reaches the whole mailbox without asking the model for anything. Batched
   * with a yield between batches, like the rules sweep. Returns how many moved.
   */
  async sweepAttention(): Promise<number> {
    const ctx = this.context();
    const page = this.db.prepare(
      `SELECT c.account_id, c.thread_id, c.type, c.source, c.split, c.band
       FROM classifications c
       WHERE c.account_id > ? OR (c.account_id = ? AND c.thread_id > ?)
       ORDER BY c.account_id, c.thread_id LIMIT ?`
    );
    let atAccount = "";
    let atThread = "";
    let scored = 0;
    let moved = 0;
    for (;;) {
      if (this.stopped) break;
      const work = page.all(atAccount, atAccount, atThread, SWEEP_BATCH) as unknown as Array<{ account_id: string; thread_id: string; type: string | null; source: string; split: string; band: string }>;
      if (work.length === 0) break;
      atAccount = work[work.length - 1]!.account_id;
      atThread = work[work.length - 1]!.thread_id;
      const touched = new Set<string>();
      for (const row of work) {
        try {
          const out = attentionFor(this.db, row.account_id, row.thread_id, ctx, { type: row.type });
          if (!out) continue;
          scored += 1;
          // A re-file is the user's answer. Keep the split they chose and record the score beside it.
          const split = row.source === "manual" ? (row.split === "important" ? "important" : "other") : out.split;
          const band: AttentionBand = row.source === "manual" ? (split === "important" ? "important" : "other") : out.band;
          if (split !== row.split || band !== row.band) moved += 1;
          updateAttention(this.db, { accountId: row.account_id, threadId: row.thread_id, split, attention: out.attention, band, reason: out.reason });
          touched.add(row.account_id);
        } catch (err) {
          logError("classify", `attention ${row.account_id}/${row.thread_id}`, err);
        }
      }
      if (touched.size) this.onChanged(touched);
      await yieldToLoop();
    }
    setSetting(this.db, "attentionVersion", ATTENTION_VERSION);
    log("classify", `attention v${ATTENTION_VERSION}: scored ${scored} thread(s), ${moved} changed band`);
    return moved;
  }

  /**
   * When the deterministic rules change, every verdict they produced is stale, whatever type it
   * carried. Drop all rule-sourced rows so the next pass re-decides them; model verdicts and the
   * manual rows a correction writes stay exactly where the user put them. Returns how many went.
   */
  private reclassifyAfterRuleChange(): number {
    if (getSetting(this.db, "rulesVersion") >= RULES_VERSION) return 0;
    const n = Number(this.db.prepare("DELETE FROM classifications WHERE source = 'rule'").run().changes);
    setSetting(this.db, "rulesVersion", RULES_VERSION);
    log("classify", `rules v${RULES_VERSION}: reset ${n} rule verdict(s) for re-evaluation`);
    return n;
  }

  /**
   * The deterministic half of a re-evaluation, run over everything the rules can answer without a
   * model. Thousands of threads settle in seconds this way, and only the residue is left for the
   * model pass, which is the slow one. Batched, with a yield between batches so nothing blocks.
   */
  private async sweepRules(): Promise<void> {
    const ctx = this.context();
    // A keyset walk over every thread, newest first. Asking for "threads with no verdict" would
    // stall: the ones the rules cannot answer stay unclassified and would fill the batch forever.
    // The walk covers old threads too, because a rule change reaches back as far as the mailbox does.
    const page = this.db.prepare(
      `SELECT t.account_id, t.id, t.sort_at, c.thread_id IS NOT NULL AS classified
       FROM threads t
       LEFT JOIN classifications c ON c.account_id = t.account_id AND c.thread_id = t.id
       WHERE t.sort_at < ? OR (t.sort_at = ? AND t.id > ?)
       ORDER BY t.sort_at DESC, t.id ASC LIMIT ?`
    );
    let atSort = Number.MAX_SAFE_INTEGER;
    let atId = "";
    let decided = 0;
    let looked = 0;
    for (;;) {
      if (this.stopped) return;
      const work = page.all(atSort, atSort, atId, SWEEP_BATCH) as unknown as Array<{ account_id: string; id: string; sort_at: number; classified: number }>;
      if (work.length === 0) break;
      atSort = work[work.length - 1]!.sort_at;
      atId = work[work.length - 1]!.id;
      const touched = new Set<string>();
      for (const t of work) {
        // A model verdict or a re-file survived the reset and is not the rules' to overwrite.
        if (t.classified) continue;
        looked += 1;
        try {
          const out = ruleVerdictFor(this.db, t.account_id, t.id, ctx);
          if (!out) continue;
          const last = listThreadMessages(this.db, t.account_id, t.id).at(-1);
          upsertClassification(this.db, { accountId: t.account_id, threadId: t.id, split: out.split, type: out.type, categoryId: out.categoryId, confidence: out.confidence, source: out.source, lastMessageId: last?.id ?? null, attention: out.attention, band: out.band, reason: out.reason });
          decided += 1;
          touched.add(t.account_id);
        } catch (err) {
          logError("classify", `sweep ${t.account_id}/${t.id}`, err);
        }
      }
      if (touched.size) this.onChanged(touched);
      log("classify", `rules sweep: ${decided} of ${looked} thread(s) decided so far`);
      await yieldToLoop();
    }
    log("classify", `rules sweep done: ${decided} of ${looked} thread(s) decided, ${looked - decided} left for the model`);
    this.poke();
  }

  /** The replied-to sets and the owner addresses, read once per pass. */
  private context(): ClassifyContext {
    const replied = repliedTo(this.db, 90);
    return {
      repliedDomains: replied.domains,
      repliedAddresses: replied.addresses,
      ownerAddresses: new Set(this.ownerAddresses().map((a) => a.toLowerCase())),
      attention: attentionContext(this.db),
    };
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
    const limit = 40;
    const work = threadsNeedingClassification(this.db, { limit });
    if (work.length === 0) return;
    const ctx = this.context();
    const touched = new Set<string>();
    let modelDown = false;
    for (const t of work) {
      if (this.stopped) break;
      try {
        const out = await classifyThread(this.db, this.ai, t.account_id, t.id, ctx);
        if (!out) continue;
        const last = listThreadMessages(this.db, t.account_id, t.id).at(-1);
        upsertClassification(this.db, { accountId: t.account_id, threadId: t.id, split: out.split, type: out.type, categoryId: out.categoryId, confidence: out.confidence, source: out.source, lastMessageId: last?.id ?? null, attention: out.attention, band: out.band, reason: out.reason });
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
      await yieldToLoop();
    }
    if (touched.size) {
      log("classify", `classified ${touched.size ? work.length : 0} thread(s)${modelDown ? " before the model went away" : ""}`);
      this.onChanged(touched);
    }
    // A full batch means there is more waiting. Ask for another pass now rather than at the next tick.
    if (!modelDown && work.length === limit) this.queued = true;
  }

  /** After a custom category is added: reclassify the last 30 days in the background and apply category labels. */
  reclassifyRecent(days = 30): void {
    if (this.stopped) return;
    const threads = recentThreads(this.db, days);
    log("classify", `reclassifying ${threads.length} thread(s) from the last ${days} days`);
    void (async () => {
      const ctx = this.context();
      const categories = listCategories(this.db);
      const touched = new Set<string>();
      let done = 0;
      for (const t of threads) {
        if (this.stopped) break;
        try {
          const out = await classifyThread(this.db, this.ai, t.account_id, t.id, ctx);
          if (!out) continue;
          const last = listThreadMessages(this.db, t.account_id, t.id).at(-1);
          upsertClassification(this.db, { accountId: t.account_id, threadId: t.id, split: out.split, type: out.type, categoryId: out.categoryId, confidence: out.confidence, source: out.source, lastMessageId: last?.id ?? null, attention: out.attention, band: out.band, reason: out.reason });
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
