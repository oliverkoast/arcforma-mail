import type { Db } from "../db.js";

/** App settings with their defaults. The renderer edits these in Settings. */
export interface Settings {
  /** Seconds a queued send can still be undone. */
  undoWindowSec: number;
  /** R prefills the reply through the draft_reply task. */
  autoDraft: boolean;
  /** Remote images in mail bodies: always, only from senders you have exchanged mail with, or never. Per-sender choices override. */
  remoteImages: "always" | "known" | "never";
  /** Version of the deterministic rules the stored rule-sourced classifications were made with. */
  rulesVersion: number;
  /** Version of the attention weights the stored scores were made with. A bump rescores every verdict in place. */
  attentionVersion: number;
  /** When the current day began for Daily 0: the last activity of the night before. 0 until the app has seen a day. */
  dayStartAt: number;
  /** Last keyboard or mouse activity the app recorded, throttled. 0 until the first one. */
  lastActiveAt: number;
  /** Monday 4:00 local of the current week for Weekly 0. 0 until the app has seen a week. */
  weekStartAt: number;
  /** Days after a message to a client goes out before a remind-if-no-reply fires on its thread. 0 turns the rule off. */
  remindClientsAfterDays: number;
  /** Category ids or names whose threads and correspondents count as clients for that rule. */
  remindScope: string[];
  /**
   * Whether read receipts are available at all. Off unless someone turns them
   * on, and turning them on arms nothing: every message is still chosen one at
   * a time. See docs/adr/0003-read-receipts-reverse-an-earlier-decision.md.
   */
  readReceipts: boolean;
  /** The pixel service this app registers tokens with and collects from. Empty until one is deployed. */
  readReceiptsUrl: string;
  /** The first-run onboarding step that was on screen when the app last quit, so a resume lands there. */
  onboardingStep: string;
  /** True once someone pressed Start reading at the end of onboarding. Until then the flow owns the window. */
  onboardingDone: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  undoWindowSec: 10,
  autoDraft: false,
  remoteImages: "always",
  rulesVersion: 0,
  attentionVersion: 0,
  dayStartAt: 0,
  lastActiveAt: 0,
  weekStartAt: 0,
  remindClientsAfterDays: 3,
  remindScope: ["Clients"],
  readReceipts: false,
  readReceiptsUrl: "",
  onboardingStep: "welcome",
  onboardingDone: false,
};

export function getSetting<K extends keyof Settings>(db: Db, key: K): Settings[K] {
  const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | undefined;
  if (!row) return DEFAULT_SETTINGS[key];
  try {
    return JSON.parse(row.value_json) as Settings[K];
  } catch {
    return DEFAULT_SETTINGS[key];
  }
}

export function setSetting<K extends keyof Settings>(db: Db, key: K, value: Settings[K]): void {
  db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at").run(
    key,
    JSON.stringify(value),
    Date.now()
  );
}

export function getSettings(db: Db): Settings {
  return {
    undoWindowSec: getSetting(db, "undoWindowSec"),
    autoDraft: getSetting(db, "autoDraft"),
    remoteImages: getSetting(db, "remoteImages"),
    rulesVersion: getSetting(db, "rulesVersion"),
    attentionVersion: getSetting(db, "attentionVersion"),
    dayStartAt: getSetting(db, "dayStartAt"),
    lastActiveAt: getSetting(db, "lastActiveAt"),
    weekStartAt: getSetting(db, "weekStartAt"),
    remindClientsAfterDays: getSetting(db, "remindClientsAfterDays"),
    remindScope: getSetting(db, "remindScope"),
    readReceipts: getSetting(db, "readReceipts"),
    readReceiptsUrl: getSetting(db, "readReceiptsUrl"),
    onboardingStep: getSetting(db, "onboardingStep"),
    onboardingDone: getSetting(db, "onboardingDone"),
  };
}

export function undoWindowMs(db: Db): number {
  const sec = Number(getSetting(db, "undoWindowSec"));
  return Math.max(0, Math.min(60, Number.isFinite(sec) ? sec : DEFAULT_SETTINGS.undoWindowSec)) * 1000;
}
