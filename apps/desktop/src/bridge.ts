// Typed access to the preload bridge. Outside Electron (the Vite dev server in
// a plain browser) a preview shim answers with the three known accounts signed
// out, so the shell still renders.

import { EMPTY_COUNTS, EMPTY_SIDEBAR_COUNTS, type AccountsStatus, type ArcmailEvents, type ArcmailInvoke, type EventChannel, type InvokeChannel } from "../shared/types";

interface RawBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, callback: (payload: unknown) => void) => () => void;
  platform: string;
}

export interface DSRuntime {
  dither: (w: number, h: number, opts?: { cell?: number; seed?: number }) => Array<{ x: number; y: number; order: number }>;
  drawDither: (ctx: CanvasRenderingContext2D, cells: Array<{ x: number; y: number }>, p: number, opts?: { cell?: number; fill?: string }) => void;
  color: Record<string, string>;
  clamp: (v: number, a?: number, b?: number) => number;
}

declare global {
  interface Window {
    arcmail?: RawBridge;
    DS?: DSRuntime;
  }
}

const PREVIEW_STATUS: AccountsStatus = {
  accounts: [
    { id: "arcforma", email: "you@example.com", displayName: null, consent: "internal", authState: "signed_out", syncState: "new", configured: false, backfill: null, lastSyncAt: null, error: null },
    { id: "formai", email: "you@example.net", displayName: null, consent: "internal", authState: "signed_out", syncState: "new", configured: false, backfill: null, lastSyncAt: null, error: null },
    { id: "personal", email: "you@gmail.com", displayName: null, consent: "external", authState: "signed_out", syncState: "new", configured: false, backfill: null, lastSyncAt: null, error: null },
  ],
  configPath: "~/Library/Application Support/Arcforma Mail/oauth-clients.json",
  configError: "Browser preview. Sign-in and sync need the desktop app.",
};

const previewBridge: RawBridge = {
  platform: "browser",
  on: () => () => {},
  invoke: async (channel) => {
    switch (channel) {
      case "accounts:status":
        return PREVIEW_STATUS;
      case "accounts:signIn":
        throw new Error("Sign-in needs the desktop app.");
      case "threads:list":
        return { rows: [], nextCursor: null };
      case "threads:counts":
        return EMPTY_COUNTS;
      case "sidebar:counts":
        return EMPTY_SIDEBAR_COUNTS;
      case "sidebar:getLayout":
        return null;
      case "searches:list":
        return [];
      case "categories:list":
        return [];
      case "search:query":
        return [];
      case "scheduler:status":
        return { snoozes: 0, reminders: 0, queuedSends: 0, pendingOutbox: 0 };
      case "app:info":
        return { version: "preview", platform: "browser", smoke: false, userArt: [] };
      case "settings:get":
        return { undoWindowSec: 10, autoDraft: false, remoteImages: "always", remindClientsAfterDays: 3, remindScope: ["Clients"] };
      case "snippets:list":
      case "drafts:list":
        return [];
      case "compose:signature":
        return "";
      case "ai:status":
        return { ok: false, loggedIn: false, claude: "daemon_down", local: "unknown", model: null, cliVersion: null };
      default:
        return undefined;
    }
  },
};

const raw: RawBridge = window.arcmail ?? previewBridge;

export const isElectron = Boolean(window.arcmail);

export function invoke<C extends InvokeChannel>(channel: C, ...args: Parameters<ArcmailInvoke[C]>): Promise<ReturnType<ArcmailInvoke[C]>> {
  return raw.invoke(channel, ...args) as Promise<ReturnType<ArcmailInvoke[C]>>;
}

export function on<C extends EventChannel>(channel: C, callback: (payload: ArcmailEvents[C]) => void): () => void {
  return raw.on(channel, callback as (payload: unknown) => void);
}
