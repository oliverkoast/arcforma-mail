// Sandboxed preload: the only surface the renderer gets is invoke and on, and
// both are limited to the channels in shared/types.ts. Typed wrappers live in
// src/bridge.ts. CommonJS on purpose: sandboxed preloads cannot be ES modules.

import electron = require("electron");

const { contextBridge, ipcRenderer } = electron;

const EVENT_CHANNELS = new Set(["accounts:changed", "threads:changed", "sync:progress", "toast", "categories:changed", "calendar:changed", "drafts:changed", "onboarding:progress"]);

// Mirrors the keys of ArcmailInvoke in shared/types.ts; preload.test.ts keeps the two in step.
const INVOKE_CHANNELS = new Set([
  "accounts:status",
  "accounts:signIn",
  "accounts:signOut",
  "threads:list",
  "threads:get",
  "threads:markRead",
  "threads:star",
  "threads:archive",
  "threads:moveToInbox",
  "threads:trash",
  "threads:snooze",
  "threads:unsnooze",
  "threads:remind",
  "threads:unsubscribe",
  "threads:counts",
  "sidebar:counts",
  "sidebar:getLayout",
  "sidebar:setLayout",
  "searches:list",
  "searches:create",
  "searches:update",
  "searches:delete",
  "threads:toggleQueue",
  "app:activity",
  "categories:list",
  "attachments:preview",
  "attachments:download",
  "attachments:saveAs",
  "attachments:detail",
  "contacts:setLoadImages",
  "search:query",
  "scheduler:status",
  "send:undo",
  "sync:now",
  "app:info",
  "app:reportCrash",
  "app:openLogFolder",
  "compose:send",
  "compose:signature",
  "drafts:save",
  "drafts:list",
  "drafts:delete",
  "snippets:list",
  "snippets:save",
  "snippets:delete",
  "settings:get",
  "settings:set",
  "receipts:setToken",
  "receipts:check",
  "categories:create",
  "categories:update",
  "categories:delete",
  "classify:refile",
  "ai:status",
  "ai:summary",
  "ai:instantReplies",
  "ai:draftReply",
  "ai:ask",
  "calendar:list",
  "calendar:busy",
  "calendar:syncNow",
  "contacts:get",
  "contacts:photo",
  "contacts:lookupWeb",
  "app:loginItem",
  "app:setLoginItem",
  "onboarding:get",
  "onboarding:setStep",
  "onboarding:setDone",
  "onboarding:openConsole",
  "onboarding:openAccessibility",
  "onboarding:addAccount",
  "onboarding:aiState",
  "onboarding:setAi",
  "onboarding:modelState",
  "onboarding:downloadModel",
  "onboarding:cancelModel",
  "onboarding:textState",
  "onboarding:installText",
  "onboarding:checkAccessibility",
]);

contextBridge.exposeInMainWorld("arcmail", {
  invoke: (channel: string, ...args: unknown[]) => {
    if (!INVOKE_CHANNELS.has(channel)) return Promise.reject(new Error(`Unknown channel ${channel}.`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel: string, callback: (payload: unknown) => void) => {
    if (!EVENT_CHANNELS.has(channel)) return () => {};
    const listener = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
  platform: process.platform,
});
