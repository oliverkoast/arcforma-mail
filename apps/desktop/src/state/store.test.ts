import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_SIDEBAR_COUNTS, type AccountInfo, type ComposeDraft, type DraftInfo, type MessageView, type ThreadSummary, type ThreadView } from "../../shared/types";

// The store reads window.arcmail at import time; node:test hands it a bridge that records every invoke.
const calls: Array<{ channel: string; args: unknown[] }> = [];
/** Threads the fake main process can hand back for threads:get, by "account:thread". */
const threadViews = new Map<string, ThreadView>();
/** The fake drafts table: drafts:save upserts, drafts:list reads newest first, drafts:delete removes. */
const draftRows = new Map<number, DraftInfo>();
let nextDraftId = 1;
let nextSendId = 1;
/** Per-thread delay on threads:get, to race two opens. */
const threadDelays = new Map<string, number>();
/** Delay on drafts:save, to overlap two autosaves. */
let saveDelay = 0;
/** Delay on the attachment channels, so a test can look at the chip while the fetch is still running. */
let attachmentDelay = 0;
/** Makes compose:send answer with an older, receipt-less shape, to prove a sent message stays sent. */
let sendResultOmitsReceipt = false;
/** Channels whose next call fails, to check the failure reaches a toast. */
const failNext = new Map<string, string>();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
(globalThis as { window?: unknown }).window = {
  arcmail: {
    platform: "test",
    on: () => () => {},
    invoke: async (channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      const failure = failNext.get(channel);
      if (failure) {
        failNext.delete(channel);
        throw new Error(failure);
      }
      switch (channel) {
        case "threads:list":
          return { rows: [], nextCursor: null };
        case "sidebar:counts":
          return EMPTY_SIDEBAR_COUNTS;
        case "sidebar:setLayout":
          return undefined;
        case "threads:get": {
          const key = `${args[0]}:${args[1]}`;
          const delay = threadDelays.get(key);
          if (delay) await wait(delay);
          const view = threadViews.get(key);
          if (!view) throw new Error(`no fixture thread ${key}`);
          return { ...view, messages: view.messages.map((m) => ({ ...m })) };
        }
        case "drafts:save": {
          if (saveDelay) await wait(saveDelay);
          const d = args[0] as ComposeDraft;
          const id = d.draftId ?? nextDraftId++;
          draftRows.set(id, { ...d, draftId: id, updatedAt: Date.now() + id, origin: "local", mirror: { state: "pending", error: null, at: null } });
          return id;
        }
        case "drafts:list":
          return [...draftRows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
        case "drafts:delete":
          draftRows.delete(args[0] as number);
          return undefined;
        case "compose:send": {
          const r = { id: nextSendId++, sendAt: Date.now() + 10_000, undoUntil: Date.now() + 10_000, receipt: { requested: false, armed: false } };
          if (sendResultOmitsReceipt) delete (r as { receipt?: unknown }).receipt;
          return r;
        }
        case "attachments:preview": {
          if (attachmentDelay) await wait(attachmentDelay);
          return undefined;
        }
        case "attachments:download": {
          if (attachmentDelay) await wait(attachmentDelay);
          return { saved: true, path: "/Users/someone/Downloads/deck.pdf", filename: "deck.pdf" };
        }
        case "threads:unsnooze":
          return true;
        case "threads:unsubscribe":
          return unsubscribeResult;
        case "send:undo":
          return { cancelled: true, draft: { ...(lastSent ?? {}), draftId: null } };
        case "settings:set":
          settingsRow = { ...settingsRow, ...(args[0] as Record<string, unknown>) };
          return settingsRow;
        case "onboarding:get":
          return { ...onboardingRow };
        case "onboarding:setStep":
          onboardingRow = { ...onboardingRow, step: args[0] as string };
          return { ...onboardingRow };
        case "onboarding:setDone":
          onboardingRow = { ...onboardingRow, done: args[0] as boolean, step: args[0] ? onboardingRow.step : "welcome" };
          return { ...onboardingRow };
        case "onboarding:addAccount":
          addedAccounts.push(args[0] as Record<string, unknown>);
          return { accounts, configPath: onboardingRow.clientsPath, configError: null };
        default:
          return undefined;
      }
    },
  },
};
let lastSent: ComposeDraft | null = null;
/** What the fake main process says U did. Tests set it before pressing U. */
let unsubscribeResult: { method: string; ok: boolean; archived: boolean; state: string; text: string } = { method: "post", ok: true, archived: true, state: "sent", text: "Unsubscribed from Northwind." };
/** The fake settings table: settings:set merges the patch and hands the whole row back, the way the main process does. */
/** The fake settings table's onboarding half: the step and the finished flag survive a reload the way the store does. */
let onboardingRow = { step: "welcome", done: false, clientsPath: "/tmp/oauth-clients.json" };
/** Every request that reached onboarding:addAccount, so a test can check the secret went once and came back never. */
const addedAccounts: Array<Record<string, unknown>> = [];
let settingsRow: Record<string, unknown> = { undoWindowSec: 10, autoDraft: false, remoteImages: "always", remindClientsAfterDays: 3, remindScope: ["Clients"] };

const account = (id: string, email: string): AccountInfo => ({ id, email, displayName: null, consent: "internal", authState: "ok", syncState: "live", configured: true, backfill: null, lastSyncAt: null, error: null });
const accounts = [account("arcforma", "you@example.com"), account("formai", "you@example.net"), account("personal", "you@gmail.com")];
const settle = () => new Promise((r) => setTimeout(r, 0));
const lastList = () => calls.filter((c) => c.channel === "threads:list").at(-1)?.args[0] as { view: string; category: string | null; accountIds?: string[] } | undefined;

test("a single click on an account only changes the filter; a double-click also opens that account's Everything view", async () => {
  const { useApp } = await import("./store");
  useApp.setState({ status: { accounts, configPath: "", configError: null }, ready: true });
  useApp.getState().setView("inbox", { category: "clients" });
  await settle();

  useApp.getState().setAccountFilter("formai");
  await settle();
  let s = useApp.getState();
  assert.equal(s.accountFilter, "formai");
  assert.equal(s.view, "inbox");
  assert.equal(s.category, "clients", "a click keeps the current view");
  assert.deepEqual(lastList()?.accountIds, ["formai"]);
  assert.equal(lastList()?.category, "clients");

  useApp.setState({ view: "daily", split: null, category: null, open: { thread: { id: "t1" } } as never, searchQuery: "kickoff" });
  useApp.getState().openAccountInbox("personal");
  await settle();
  s = useApp.getState();
  assert.equal(s.accountFilter, "personal");
  assert.equal(s.view, "inbox");
  assert.equal(s.split, null);
  assert.equal(s.category, null);
  assert.equal(s.open, null, "the reading pane closes; the list is a different account's");
  assert.equal(s.searchQuery, "", "an active search is left");
  assert.equal(s.scope, "list");
  assert.deepEqual(lastList()?.accountIds, ["personal"]);
  assert.equal(lastList()?.view, "inbox");
});

test("the sidebar menu owns the key scope while open and gives it back on close; the layout save goes to the store", async () => {
  const { useApp } = await import("./store");
  useApp.getState().openSidebarMenu({ kind: "add", group: "inbox", anchor: { x: 10, y: 20 } });
  assert.equal(useApp.getState().scope, "sidebar");
  useApp.getState().closeSidebarMenu();
  assert.equal(useApp.getState().scope, "list");
  const layout = { version: 1 as const, groups: [{ id: "queues" as const, rows: [{ id: "daily", hidden: false }] }] };
  await useApp.getState().saveSidebarLayout(layout);
  assert.deepEqual(useApp.getState().sidebarLayout, layout);
  assert.deepEqual(calls.filter((c) => c.channel === "sidebar:setLayout").at(-1)?.args, [layout]);
});

// ---- inline reply ----------------------------------------------------------------------

function message(threadId: string, id: string, over: Partial<MessageView>): MessageView {
  return {
    accountId: "arcforma",
    id,
    threadId,
    internalDate: Date.UTC(2026, 8, 1, 9, 0),
    from: { email: "dana@northwind.example", name: "Dana Reyes" },
    replyTo: null,
    to: [{ email: "you@example.com", name: "Oliver Korzen" }],
    cc: [],
    bcc: [],
    messageIdHeader: `<${id}@x>`,
    references: null,
    subject: "Kickoff next week",
    snippet: "",
    labelIds: ["INBOX"],
    direction: "in",
    isAuto: true,
    hasAttachments: false,
    body: { html: `<p>body of ${id}</p>`, text: null, attachments: [] },
    loadImages: false,
    ...over,
  };
}

function summary(id: string, subject: string): ThreadSummary {
  return { accountId: "arcforma", id, subject, snippet: "", participants: [], lastMessageAt: 0, sortAt: 0, messageCount: 1, unread: false, starred: false, inInbox: true, hasAttachments: false, split: null, type: null, categoryId: null, attention: null, band: null, attentionReason: null, wakeAt: null, noReplyBy: null, queue: null, canUnsubscribe: false, unsubscribeState: null };
}

const kickoff: ThreadView = {
  thread: summary("t-kickoff", "Kickoff next week"),
  messages: [
    message("t-kickoff", "m1", {}),
    message("t-kickoff", "m2", { direction: "out", from: { email: "you@example.com", name: "Oliver Korzen" }, to: [{ email: "dana@northwind.example", name: "Dana Reyes" }], references: "<m1@x>" }),
    message("t-kickoff", "m3", { from: { email: "priya@northwind.example", name: "Priya Natarajan" }, cc: [{ email: "dana@northwind.example", name: "" }], references: "<m1@x> <m2@x>", subject: "Re: Kickoff next week" }),
    message("t-kickoff", "m4", { cc: [{ email: "priya@northwind.example", name: "Priya Natarajan" }], references: "<m1@x> <m2@x> <m3@x>", subject: "Re: Kickoff next week" }),
  ],
  bodiesPending: false,
};
const agreement: ThreadView = { thread: summary("t-agreement", "Draft services agreement"), messages: [message("t-agreement", "a1", { from: { email: "sam@harbor.example", name: "Sam Okafor" }, subject: "Draft services agreement" })], bodiesPending: false };
threadViews.set("arcforma:t-kickoff", kickoff);
threadViews.set("arcforma:t-agreement", agreement);

/** The editor the components would mount: records what the store pushes into it. */
function fakeEditor() {
  const log: string[] = [];
  return { log, api: { insertHtml: (h: string) => log.push(`insert:${h}`), setHtml: (h: string) => log.push(`set:${h}`), focus: () => log.push("focus") } };
}

async function freshKickoff() {
  const { useApp } = await import("./store");
  draftRows.clear();
  useApp.setState({ status: { accounts, configPath: "", configError: null }, ready: true, readingPane: true, compose: null, composePlacement: "panel", inlineCollapsed: false, inlineAnchor: null, drafts: [], open: null, toast: null, popover: null, sidebarMenu: null, settingsOpen: false, ask: { open: false, question: "", running: false, result: null } });
  useApp.getState().syncScope();
  await useApp.getState().openThreadById("arcforma", "t-kickoff");
  await settle();
  return useApp;
}

test("R on an open thread docks the reply under the last message; C opens the panel and parks the inline reply as a draft", async () => {
  const useApp = await freshKickoff();
  assert.equal(useApp.getState().scope, "thread");
  useApp.getState().openCompose("reply");
  let s = useApp.getState();
  assert.equal(s.composePlacement, "inline");
  assert.equal(s.inlineCollapsed, false);
  assert.deepEqual(s.inlineAnchor, { accountId: "arcforma", threadId: "t-kickoff", messageId: "m4" }, "docked under the last message");
  assert.equal(s.scope, "compose", "plain letters are typing now");
  assert.equal(s.compose?.mode, "reply");
  assert.equal(s.compose?.threadId, "t-kickoff");
  assert.deepEqual(s.compose?.to.map((a) => a.email), ["dana@northwind.example"]);
  assert.equal(s.compose?.inReplyTo, "<m4@x>");

  // Reply all and Forward from the header dock the same way; the box moves rather than a second one opening.
  useApp.getState().openCompose("replyAll");
  s = useApp.getState();
  assert.equal(s.compose?.mode, "replyAll");
  assert.deepEqual(s.compose?.cc.map((a) => a.email), ["priya@northwind.example"]);
  assert.equal(s.composePlacement, "inline");

  useApp.getState().updateCompose({ bodyHtml: "<p>Priya should join.</p>" });
  useApp.getState().openCompose("new");
  await settle();
  s = useApp.getState();
  assert.equal(s.composePlacement, "panel", "C keeps the floating panel");
  assert.equal(s.compose?.mode, "new");
  assert.equal(s.inlineAnchor, null);
  assert.equal(s.scope, "compose");
  const parked = [...draftRows.values()].find((d) => d.threadId === "t-kickoff");
  assert.ok(parked, "the inline reply was saved as a local draft");
  assert.equal(parked?.bodyHtml, "<p>Priya should join.</p>");
  assert.equal(parked?.mode, "replyAll");
  assert.equal(s.drafts.some((d) => d.draftId === parked?.draftId), true, "and shows under the thread as its strip");
  await useApp.getState().closeCompose(false);
});

test("Escape collapses an inline reply with text to its strip and gives the keys back; R and expandInline reopen it; an untouched reply just closes", async () => {
  const useApp = await freshKickoff();
  const savesBefore = calls.filter((c) => c.channel === "drafts:save").length;
  useApp.getState().openCompose("reply");
  assert.equal(useApp.getState().scope, "compose");
  // Nothing written yet: Escape closes without a draft.
  await useApp.getState().dismissCompose();
  let s = useApp.getState();
  assert.equal(s.compose, null);
  assert.equal(s.scope, "thread");
  assert.equal(draftRows.size, 0, "recipients alone are not a draft");
  assert.equal(calls.filter((c) => c.channel === "drafts:save").length, savesBefore, "nothing was written to the drafts table");

  useApp.getState().openCompose("reply");
  useApp.getState().updateCompose({ bodyHtml: "<p>Yes, 9:00 works for the first block.</p>" });
  await useApp.getState().dismissCompose();
  s = useApp.getState();
  assert.ok(s.compose, "the draft stays in memory behind the strip");
  assert.equal(s.inlineCollapsed, true);
  assert.equal(s.scope, "thread", "J and K work again");
  assert.equal(typeof s.compose?.draftId, "number", "and it is in the drafts table in case the app quits");

  useApp.getState().openCompose("reply");
  s = useApp.getState();
  assert.equal(s.inlineCollapsed, false, "R reopens the strip");
  assert.equal(s.scope, "compose");
  assert.equal(s.compose?.bodyHtml, "<p>Yes, 9:00 works for the first block.</p>", "with what was typed");
  await useApp.getState().dismissCompose();
  useApp.getState().expandInline();
  assert.equal(useApp.getState().inlineCollapsed, false, "a click on the strip does the same");
  await useApp.getState().closeCompose(false);
  assert.equal(draftRows.size, 0, "discarding removes the table row too");
});

test("moving to another thread parks the inline draft; back on the thread its strip is there and R reopens the saved draft under the message it answers", async () => {
  const useApp = await freshKickoff();
  useApp.getState().openCompose("reply", { messageId: "m3" });
  useApp.getState().updateCompose({ bodyHtml: "<p>Early is fine, Priya.</p>" });
  await useApp.getState().openThreadById("arcforma", "t-agreement");
  await settle();
  let s = useApp.getState();
  assert.equal(s.open?.thread.id, "t-agreement");
  assert.equal(s.compose, null, "the box went with the thread");
  assert.equal(s.scope, "thread");
  const saved = [...draftRows.values()][0];
  assert.equal(saved?.threadId, "t-kickoff");
  assert.equal(saved?.inReplyTo, "<m3@x>");
  assert.equal(saved?.bodyHtml, "<p>Early is fine, Priya.</p>");

  await useApp.getState().openThreadById("arcforma", "t-kickoff");
  await settle();
  const { savedDraftFor } = await import("../components/InlineReply");
  s = useApp.getState();
  assert.equal(savedDraftFor(s.open!, s.drafts)?.draftId, saved?.draftId, "the strip comes from the drafts table");
  useApp.getState().openCompose("reply");
  s = useApp.getState();
  assert.equal(s.composePlacement, "inline");
  assert.equal(s.compose?.draftId, saved?.draftId, "R reopens that draft, not a fresh reply");
  assert.equal(s.compose?.bodyHtml, "<p>Early is fine, Priya.</p>");
  assert.equal(s.inlineAnchor?.messageId, "m3", "docked under the message it answers");
  await useApp.getState().closeCompose(false);

  // Closing the thread (Escape back to the list) parks the draft the same way.
  useApp.getState().openCompose("reply");
  useApp.getState().updateCompose({ bodyHtml: "<p>Second try.</p>" });
  useApp.getState().closeThread();
  await settle();
  s = useApp.getState();
  assert.equal(s.compose, null);
  assert.equal(s.scope, "list");
  assert.equal([...draftRows.values()].some((d) => d.bodyHtml === "<p>Second try.</p>"), true);
  draftRows.clear();
});

test("reply targets the chosen message: recipients, subject, In-Reply-To, and the quote come from it; moving the box keeps the typed text", async () => {
  const useApp = await freshKickoff();
  const ed = fakeEditor();
  useApp.getState().setEditorApi(ed.api);
  useApp.getState().openCompose("reply", { messageId: "m3" });
  let s = useApp.getState();
  assert.deepEqual(s.inlineAnchor, { accountId: "arcforma", threadId: "t-kickoff", messageId: "m3" });
  assert.deepEqual(s.compose?.to, [{ email: "priya@northwind.example", name: "Priya Natarajan" }], "To is Priya, the sender of m3, not Dana from the thread's latest");
  assert.deepEqual(s.compose?.cc, []);
  assert.equal(s.compose?.inReplyTo, "<m3@x>");
  assert.equal(s.compose?.references, "<m1@x> <m2@x> <m3@x>");
  assert.equal(s.compose?.subject, "Re: Kickoff next week");
  assert.match(s.compose?.quotedHtml ?? "", /body of m3/);
  assert.doesNotMatch(s.compose?.quotedHtml ?? "", /body of m4/, "only that message is quoted");

  useApp.getState().openCompose("replyAll", { messageId: "m3" });
  s = useApp.getState();
  assert.deepEqual(s.compose?.cc.map((a) => a.email), ["dana@northwind.example"], "reply all on m3 copies Dana");

  useApp.getState().updateCompose({ bodyHtml: "<p>Keep this text.</p>" });
  useApp.getState().openCompose("reply", { messageId: "m1" });
  s = useApp.getState();
  assert.equal(s.inlineAnchor?.messageId, "m1", "the box moved under m1");
  assert.equal(s.compose?.bodyHtml, "<p>Keep this text.</p>", "what was typed came along");
  assert.equal(s.compose?.inReplyTo, "<m1@x>");
  assert.deepEqual(s.compose?.to.map((a) => a.email), ["dana@northwind.example"]);
  assert.equal(s.scope, "compose");

  useApp.getState().openCompose("reply", { messageId: "m1" });
  assert.equal(ed.log.at(-1), "focus", "the same message again just focuses the box");

  // The bottom row targets the last message.
  useApp.getState().openCompose("reply", { messageId: "m4" });
  assert.equal(useApp.getState().compose?.inReplyTo, "<m4@x>");
  await useApp.getState().closeCompose(false);
});

test("an instant reply prefills the docked box, open or collapsed", async () => {
  const useApp = await freshKickoff();
  useApp.setState({ replies: { ok: true, cached: false, replies: ["Yes, Priya should join.", "Week two is better.", "Let me check."] } });
  useApp.getState().acceptInstantReply(1);
  let s = useApp.getState();
  assert.equal(s.composePlacement, "inline", "1 with no box open opens the inline reply");
  assert.equal(s.compose?.bodyHtml, "<p>Yes, Priya should join.</p>");
  const ed = fakeEditor();
  useApp.getState().setEditorApi(ed.api);
  useApp.getState().acceptInstantReply(2);
  s = useApp.getState();
  assert.equal(s.compose?.bodyHtml, "<p>Week two is better.</p>");
  assert.equal(ed.log.at(-1), "set:<p>Week two is better.</p>", "the mounted editor gets the text");
  assert.equal(s.inlineAnchor?.messageId, "m4");
  await useApp.getState().dismissCompose();
  assert.equal(useApp.getState().inlineCollapsed, true);
  useApp.getState().acceptInstantReply(3);
  s = useApp.getState();
  assert.equal(s.inlineCollapsed, false, "3 on the strip reopens the box");
  assert.equal(s.compose?.bodyHtml, "<p>Let me check.</p>");
  await useApp.getState().closeCompose(false);
});

test("Send replaces the inline box with the message appended to the thread; Z takes it back out and reopens the draft inline", async () => {
  const useApp = await freshKickoff();
  useApp.getState().openCompose("reply");
  useApp.getState().updateCompose({ bodyHtml: "<p>Sending this.</p>" });
  lastSent = useApp.getState().compose;
  await useApp.getState().sendCompose(null);
  let s = useApp.getState();
  assert.equal(s.compose, null);
  assert.equal(s.scope, "thread");
  const last = s.open?.messages.at(-1);
  assert.equal(last?.id, "pending:1");
  assert.equal(last?.direction, "out");
  assert.equal(last?.from.email, "you@example.com");
  assert.equal(last?.body?.html, "<p>Sending this.</p>");
  assert.equal(s.open?.messages.length, 5);
  assert.equal(s.toast?.undo?.kind, "send");

  // The sync has not seen it yet: a refetch keeps the optimistic copy.
  await useApp.getState().refreshOpen();
  assert.equal(useApp.getState().open?.messages.at(-1)?.id, "pending:1");

  await useApp.getState().undo();
  s = useApp.getState();
  assert.equal(s.open?.messages.length, 4, "undo removes the optimistic message");
  assert.equal(s.composePlacement, "inline", "and the draft is back under the thread");
  assert.equal(s.compose?.bodyHtml, "<p>Sending this.</p>");
  assert.equal(s.inlineAnchor?.messageId, "m4");
  await useApp.getState().closeCompose(false);

  // Send later is a queued send, not a message in the thread.
  useApp.getState().openCompose("reply");
  useApp.getState().updateCompose({ bodyHtml: "<p>Later.</p>" });
  await useApp.getState().sendCompose(Date.now() + 3_600_000);
  assert.equal(useApp.getState().open?.messages.length, 4);
  useApp.getState().showToast(null);
});

test("a message that has left is never reported as not sent, whatever fails afterwards", async () => {
  // The regression: sendCompose wrapped the invoke and everything after it in one try. When a later
  // step threw on a field the main process had started returning, the catch showed "NOT SENT" for a
  // message Gmail had already accepted. Only the invoke is guarded now.
  const useApp = await freshKickoff();
  useApp.getState().openCompose("reply");
  useApp.getState().updateCompose({ bodyHtml: "<p>Gone already.</p>" });
  sendResultOmitsReceipt = true;
  try {
    await useApp.getState().sendCompose(null);
  } finally {
    sendResultOmitsReceipt = false;
  }
  const s = useApp.getState();
  assert.notEqual(s.toast?.eyebrow, "NOT SENT", "the send succeeded, so nothing may say it did not");
  assert.match(s.toast?.text ?? "", /^Sent\./);
  assert.equal(s.toast?.undo?.kind, "send", "and undo still has something to take back");
  assert.equal(s.compose, null, "the compose closed, because the message went");
  useApp.getState().showToast(null);
});

// ---- autosave and the Gmail mirror -----------------------------------------------------

test("typing autosaves two seconds after the last edit without touching the compose's draftId; close and send fold the row id back in", async () => {
  const useApp = await freshKickoff();
  const { AUTOSAVE_MS } = await import("./store");
  const savesBefore = calls.filter((c) => c.channel === "drafts:save").length;
  useApp.getState().openCompose("reply");
  useApp.getState().updateCompose({ bodyHtml: "<p>Yes,</p>" });
  await new Promise((r) => setTimeout(r, AUTOSAVE_MS - 600));
  useApp.getState().updateCompose({ bodyHtml: "<p>Yes, 9:00 works.</p>" });
  await new Promise((r) => setTimeout(r, AUTOSAVE_MS - 600));
  assert.equal(calls.filter((c) => c.channel === "drafts:save").length, savesBefore, "still typing: nothing saved yet");
  await new Promise((r) => setTimeout(r, 700));
  let saves = calls.filter((c) => c.channel === "drafts:save");
  assert.equal(saves.length, savesBefore + 1, "one save, two seconds after the last keystroke");
  const saved = saves.at(-1)!.args[0] as ComposeDraft;
  assert.equal(saved.bodyHtml, "<p>Yes, 9:00 works.</p>");
  assert.equal(saved.draftId, null, "a new row");
  assert.equal(saves.at(-1)!.args[1], undefined, "an autosave is not a flush");
  let s = useApp.getState();
  assert.equal(typeof s.autosavedDraftId, "number");
  assert.equal(s.compose?.draftId, null, "the compose the editor is keyed on did not change");
  assert.equal(s.drafts.some((d) => d.draftId === s.autosavedDraftId), true, "and it counts under Drafts");
  const rowId = s.autosavedDraftId!;

  // The next autosave updates the same row.
  useApp.getState().updateCompose({ bodyHtml: "<p>Yes, 9:00 works. See you then.</p>" });
  await new Promise((r) => setTimeout(r, AUTOSAVE_MS + 100));
  saves = calls.filter((c) => c.channel === "drafts:save");
  assert.equal((saves.at(-1)!.args[0] as ComposeDraft).draftId, rowId);
  assert.equal(draftRows.size, 1);

  // Esc collapses inline: a flush on the same row, and the compose now carries the id.
  await useApp.getState().dismissCompose();
  saves = calls.filter((c) => c.channel === "drafts:save");
  assert.equal((saves.at(-1)!.args[0] as ComposeDraft).draftId, rowId);
  assert.deepEqual(saves.at(-1)!.args[1], { flush: true });
  s = useApp.getState();
  assert.equal(s.compose?.draftId, rowId);
  assert.equal(s.autosavedDraftId, null);

  // Discarding deletes that row, not a fresh one.
  await useApp.getState().closeCompose(false);
  assert.equal(draftRows.size, 0);
  assert.deepEqual(calls.filter((c) => c.channel === "drafts:delete").at(-1)?.args, [rowId]);

  // Send after an autosave hands the row id to the main process so its Gmail draft follows the send.
  useApp.getState().openCompose("reply");
  useApp.getState().updateCompose({ bodyHtml: "<p>Sending after a pause.</p>" });
  await new Promise((r) => setTimeout(r, AUTOSAVE_MS + 100));
  const autosaved = useApp.getState().autosavedDraftId;
  assert.equal(typeof autosaved, "number");
  lastSent = useApp.getState().compose;
  await useApp.getState().sendCompose(null);
  const sent = calls.filter((c) => c.channel === "compose:send").at(-1)!.args[0] as ComposeDraft;
  assert.equal(sent.draftId, autosaved);
  assert.equal(useApp.getState().autosavedDraftId, null);
  useApp.getState().showToast(null);
  draftRows.clear();
});

test("closing right after a keystroke cancels the pending autosave, so nothing is written for a discarded compose", async () => {
  const useApp = await freshKickoff();
  const { AUTOSAVE_MS } = await import("./store");
  const savesBefore = calls.filter((c) => c.channel === "drafts:save").length;
  useApp.getState().openCompose("reply");
  useApp.getState().updateCompose({ bodyHtml: "<p>Never mind.</p>" });
  await useApp.getState().closeCompose(false);
  await new Promise((r) => setTimeout(r, AUTOSAVE_MS + 100));
  assert.equal(calls.filter((c) => c.channel === "drafts:save").length, savesBefore);
  assert.equal(draftRows.size, 0);
});

test("the Follow-ups settings save as a partial patch: the day count and the client categories, nothing else", async () => {
  const { useApp } = await import("./store");
  await useApp.getState().saveSettings({ remindClientsAfterDays: 5 });
  let call = calls.filter((c) => c.channel === "settings:set").at(-1)!;
  assert.deepEqual(call.args, [{ remindClientsAfterDays: 5 }]);
  assert.equal(useApp.getState().settings.remindClientsAfterDays, 5);
  assert.deepEqual(useApp.getState().settings.remindScope, ["Clients"], "the other key is untouched");

  await useApp.getState().saveSettings({ remindScope: ["Clients", "vendors"] });
  call = calls.filter((c) => c.channel === "settings:set").at(-1)!;
  assert.deepEqual(call.args, [{ remindScope: ["Clients", "vendors"] }]);
  assert.deepEqual(useApp.getState().settings.remindScope, ["Clients", "vendors"]);
  assert.equal(useApp.getState().settings.remindClientsAfterDays, 5);

  await useApp.getState().saveSettings({ remindClientsAfterDays: 0 });
  assert.equal(useApp.getState().settings.remindClientsAfterDays, 0, "0 turns the rule off and is stored as 0, not dropped");
});

test("Cmd+K: the palette opens from the list, the thread, and the compose editor, never from Settings or Ask, and Escape hands the keys back", async () => {
  const useApp = await freshKickoff();
  assert.equal(useApp.getState().scope, "thread");
  useApp.getState().openPalette();
  let s = useApp.getState();
  assert.equal(s.paletteOpen, true);
  assert.equal(s.scope, "palette");
  assert.equal(s.paletteScope, "thread");
  useApp.getState().setPaletteQuery("sno");
  assert.equal(useApp.getState().paletteQuery, "sno");
  useApp.getState().closePalette();
  s = useApp.getState();
  assert.equal(s.paletteOpen, false);
  assert.equal(s.paletteQuery, "", "the text does not carry over to the next open");
  assert.equal(s.scope, "thread");

  useApp.getState().openCompose("reply");
  assert.equal(useApp.getState().scope, "compose");
  useApp.getState().togglePalette();
  assert.equal(useApp.getState().scope, "palette");
  assert.equal(useApp.getState().paletteScope, "compose", "the compose command set");
  useApp.getState().togglePalette();
  assert.equal(useApp.getState().scope, "compose");
  await useApp.getState().closeCompose(false);

  useApp.getState().openSettings();
  useApp.getState().openPalette();
  assert.equal(useApp.getState().paletteOpen, false, "Settings keeps the keys");
  useApp.getState().closeSettings();
  useApp.getState().openAsk();
  useApp.getState().openPalette();
  assert.equal(useApp.getState().paletteOpen, false, "Ask keeps the keys");
  useApp.getState().closeAsk();

  useApp.getState().setPopover("snooze");
  useApp.getState().openPalette();
  s = useApp.getState();
  assert.equal(s.scope, "palette");
  assert.equal(s.popover, null, "the popover under it closes so T, W, D never fire behind the palette");
  useApp.getState().closePalette();
});

// ---- reliability: the reading pane, sends, autosave, drafts ------------------------------

test("two quick opens: the slower first fetch never lands over the second thread, and a close drops a fetch still in flight", async () => {
  const useApp = await freshKickoff();
  threadDelays.set("arcforma:t-kickoff", 60);
  const first = useApp.getState().openThreadById("arcforma", "t-kickoff");
  const second = useApp.getState().openThreadById("arcforma", "t-agreement");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, false, "the overtaken open reports it did not land");
  assert.equal(b, true);
  await wait(80);
  assert.equal(useApp.getState().open?.thread.id, "t-agreement", "J then J shows the second thread, not the first arriving late");
  assert.equal(useApp.getState().openLoading, false);

  const late = useApp.getState().openThreadById("arcforma", "t-kickoff");
  useApp.getState().closeThread();
  assert.equal(await late, false);
  assert.equal(useApp.getState().open, null, "Escape during the fetch stays closed");
  threadDelays.clear();
});

test("refreshOpen: a reply that arrived while reading shows up, an unchanged thread keeps its message array, and a thread gone from the store closes the pane with a toast", async () => {
  const useApp = await freshKickoff();
  const before = useApp.getState().open!.messages;
  await useApp.getState().refreshOpen();
  assert.equal(useApp.getState().open!.messages, before, "nothing changed: the frames are not reloaded");

  const arrived: ThreadView = { ...kickoff, messages: [...kickoff.messages, message("t-kickoff", "m5", { from: { email: "dana@northwind.example", name: "Dana Reyes" } })] };
  threadViews.set("arcforma:t-kickoff", arrived);
  await useApp.getState().refreshOpen();
  assert.deepEqual(useApp.getState().open!.messages.map((m) => m.id), ["m1", "m2", "m3", "m4", "m5"], "the new message is in the pane without reopening");
  threadViews.set("arcforma:t-kickoff", kickoff);

  // Bodies that failed to load: the header says so, and a retry that brings them replaces the messages.
  const noBodies: ThreadView = { ...kickoff, bodiesPending: true, bodiesError: "backend", messages: kickoff.messages.map((m) => ({ ...m, body: null })) };
  threadViews.set("arcforma:t-kickoff", noBodies);
  await useApp.getState().openThreadById("arcforma", "t-kickoff");
  assert.equal(useApp.getState().open!.bodiesPending, true);
  threadViews.set("arcforma:t-kickoff", kickoff);
  await useApp.getState().refreshOpen();
  assert.equal(useApp.getState().open!.bodiesPending, false);
  assert.ok(useApp.getState().open!.messages.every((m) => m.body), "the retry brought the bodies");

  threadViews.delete("arcforma:t-kickoff");
  await useApp.getState().refreshOpen();
  assert.equal(useApp.getState().open, null, "a thread the store no longer has is not shown as current mail");
  assert.equal(useApp.getState().toast?.eyebrow, "THREAD GONE");
  assert.equal(useApp.getState().scope, "list");
  threadViews.set("arcforma:t-kickoff", kickoff);
  useApp.getState().showToast(null);
});

test("Cmd+Enter with no recipient or nothing written is refused with a toast before the main process hears about it; the compose stays open", async () => {
  const useApp = await freshKickoff();
  const sendsBefore = calls.filter((c) => c.channel === "compose:send").length;
  useApp.getState().openCompose("reply");
  await useApp.getState().sendCompose(null);
  let s = useApp.getState();
  assert.equal(s.toast?.eyebrow, "NOT SENT");
  assert.match(s.toast?.text ?? "", /Write something/);
  assert.ok(s.compose, "still open with everything in it");
  useApp.getState().updateCompose({ bodyHtml: "<p>Now with text.</p>", to: [] });
  await useApp.getState().sendCompose(null);
  s = useApp.getState();
  assert.match(s.toast?.text ?? "", /at least one recipient/);
  assert.ok(s.compose);
  assert.equal(calls.filter((c) => c.channel === "compose:send").length, sendsBefore, "nothing reached compose:send, so no draft was detached");
  // A forward with only quoted history is a real message.
  useApp.getState().updateCompose({ mode: "forward", bodyHtml: "", to: [{ email: "sam@harbor.example", name: "" }], quotedHtml: "<div>Forwarded</div>" });
  await useApp.getState().sendCompose(null);
  assert.equal(calls.filter((c) => c.channel === "compose:send").length, sendsBefore + 1);
  assert.equal(useApp.getState().compose, null);
  useApp.getState().showToast(null);
  draftRows.clear();
});

test("two autosaves that overlap (the main process slow) write one row, not two", async () => {
  const useApp = await freshKickoff();
  useApp.getState().openCompose("reply");
  useApp.getState().updateCompose({ bodyHtml: "<p>First.</p>" });
  saveDelay = 40;
  const a = useApp.getState().autosaveCompose();
  useApp.getState().updateCompose({ bodyHtml: "<p>First. Second.</p>" });
  const b = useApp.getState().autosaveCompose();
  await Promise.all([a, b]);
  saveDelay = 0;
  assert.equal(draftRows.size, 1, "the second save waited for the first's row id and updated it");
  assert.equal([...draftRows.values()][0]?.bodyHtml, "<p>First. Second.</p>");
  await useApp.getState().closeCompose(false);
  assert.equal(draftRows.size, 0);
});

test("one thread, one reply draft: replying to another message while a draft is parked moves that draft there instead of starting a second one", async () => {
  const useApp = await freshKickoff();
  useApp.getState().openCompose("reply", { messageId: "m4" });
  useApp.getState().updateCompose({ bodyHtml: "<p>Parked under m4.</p>" });
  await useApp.getState().dismissCompose();
  const parkedId = useApp.getState().compose?.draftId;
  assert.equal(typeof parkedId, "number");
  await useApp.getState().openThreadById("arcforma", "t-agreement");
  await settle();
  await useApp.getState().openThreadById("arcforma", "t-kickoff");
  await settle();
  assert.equal(useApp.getState().compose, null);
  useApp.getState().openCompose("reply", { messageId: "m3" });
  const s = useApp.getState();
  assert.equal(s.composePlacement, "inline");
  assert.equal(s.compose?.draftId, parkedId, "the parked draft was reopened");
  assert.equal(s.inlineAnchor?.messageId, "m3", "and moved under the message just chosen");
  assert.equal(s.compose?.inReplyTo, "<m3@x>");
  assert.equal(s.compose?.bodyHtml, "<p>Parked under m4.</p>", "with its text");
  assert.equal(draftRows.size, 1, "no second row for the thread");
  await useApp.getState().closeCompose(false);
  assert.equal(draftRows.size, 0);
});

test("opening a draft from the Drafts view: a reply opens its thread and docks under it; a new message gets the panel; a reply whose thread is gone gets the panel with no error", async () => {
  const useApp = await freshKickoff();
  useApp.getState().setView("drafts");
  await settle();
  assert.equal(useApp.getState().open, null);
  const reply: DraftInfo = { draftId: 71, accountId: "arcforma", threadId: "t-kickoff", mode: "reply", to: [{ email: "dana@northwind.example", name: "Dana Reyes" }], cc: [], bcc: [], subject: "Re: Kickoff next week", bodyHtml: "<p>From the drafts list.</p>", quotedHtml: "", inReplyTo: "<m3@x>", references: null, updatedAt: 1, origin: "gmail", mirror: { state: "synced", error: null, at: 1 } };
  useApp.getState().openDraft(reply);
  await wait(20);
  let s = useApp.getState();
  assert.equal(s.open?.thread.id, "t-kickoff", "the thread opened");
  assert.equal(s.composePlacement, "inline");
  assert.equal(s.inlineAnchor?.messageId, "m3", "docked under the message it answers");
  assert.equal(s.compose?.draftId, 71);
  await useApp.getState().closeCompose(false);

  const fresh: DraftInfo = { ...reply, draftId: 72, threadId: null, mode: "new", subject: "New one", inReplyTo: null };
  useApp.getState().openDraft(fresh);
  await wait(20);
  s = useApp.getState();
  assert.equal(s.composePlacement, "panel");
  assert.equal(s.compose?.draftId, 72);
  await useApp.getState().closeCompose(false);

  useApp.setState({ error: null });
  useApp.getState().openDraft({ ...reply, draftId: 73, threadId: "t-ancient" });
  await wait(20);
  s = useApp.getState();
  assert.equal(s.composePlacement, "panel", "no thread to dock under: the panel");
  assert.equal(s.compose?.draftId, 73);
  assert.equal(s.error, null, "a thread older than the store is not an error banner");
  await useApp.getState().closeCompose(false);
  draftRows.clear();
});

test("a draft delete or a drafts read that fails says so in a toast instead of vanishing silently", async () => {
  const useApp = await freshKickoff();
  failNext.set("drafts:delete", "The store is locked.");
  await useApp.getState().deleteDraft(5);
  assert.equal(useApp.getState().toast?.eyebrow, "NOT DELETED");
  assert.match(useApp.getState().toast?.text ?? "", /locked/);
  useApp.setState({ drafts: [{ draftId: 9 } as DraftInfo] });
  failNext.set("drafts:list", "Disk full.");
  await useApp.getState().loadDrafts();
  assert.equal(useApp.getState().drafts.length, 1, "the list on screen is kept");
  assert.equal(useApp.getState().toast?.eyebrow, "DRAFTS");
  useApp.getState().showToast(null);
});

test("a draft edited in Gmail while its compose is open here takes the Gmail text once the local edit is older than the minute the main process keeps; an unchanged compose is not saved again", async () => {
  const useApp = await freshKickoff();
  const { AUTOSAVE_MS } = await import("./store");
  const ed = fakeEditor();
  useApp.getState().setEditorApi(ed.api);
  useApp.getState().openCompose("reply");
  useApp.getState().updateCompose({ bodyHtml: "<p>Typed here.</p>" });
  await new Promise((r) => setTimeout(r, AUTOSAVE_MS + 100));
  const rowId = useApp.getState().autosavedDraftId!;
  const savesBefore = calls.filter((c) => c.channel === "drafts:save").length;

  // A reload that brings the same text back (the mirror ack) changes nothing and saves nothing.
  await useApp.getState().loadDrafts();
  assert.equal(useApp.getState().compose?.bodyHtml, "<p>Typed here.</p>");
  await useApp.getState().autosaveCompose();
  assert.equal(calls.filter((c) => c.channel === "drafts:save").length, savesBefore, "nothing changed since the last save, so no row churn");

  // The main process replaced the row with what Gmail holds (the local edit was older than a minute there).
  draftRows.set(rowId, { ...draftRows.get(rowId)!, bodyHtml: "<p>Finished on the phone.</p>", subject: "Re: Kickoff next week (phone)", updatedAt: Date.now() + 1000 });
  await useApp.getState().loadDrafts();
  const s = useApp.getState();
  assert.equal(s.compose?.bodyHtml, "<p>Finished on the phone.</p>", "the compose took Gmail's text");
  assert.equal(s.compose?.subject, "Re: Kickoff next week (phone)");
  assert.deepEqual(ed.log.at(-1), "set:<p>Finished on the phone.</p>", "and the editor shows it");
  assert.equal(s.toast?.eyebrow, "UPDATED FROM GMAIL");
  await useApp.getState().autosaveCompose();
  assert.equal(calls.filter((c) => c.channel === "drafts:save").length, savesBefore, "adopting Gmail's text does not write it straight back");
  useApp.getState().showToast(null);
  await useApp.getState().closeCompose(false);
  draftRows.clear();
});


test("setup owns the window on a first run, records every step, and a reload comes back to the same one", async () => {
  const { useApp } = await import("./store");
  onboardingRow = { step: "welcome", done: false, clientsPath: "/tmp/oauth-clients.json" };

  await useApp.getState().loadOnboarding();
  let s = useApp.getState();
  assert.equal(s.onboardingOpen, true, "an unfinished setup owns the window");
  assert.equal(s.onboarding?.step, "welcome");
  assert.equal(s.scope, "setup", "no list or thread shortcut can fire behind it");

  useApp.getState().goToOnboardingStep("accounts");
  useApp.getState().goToOnboardingStep("ai");
  await settle();
  assert.equal(useApp.getState().onboarding?.step, "ai");
  assert.equal(onboardingRow.step, "ai", "the step reached the main process, not just the screen");

  // A quit here and a fresh launch: loadOnboarding reads the stored step back.
  useApp.setState({ onboarding: null, onboardingOpen: false });
  await useApp.getState().loadOnboarding();
  s = useApp.getState();
  assert.equal(s.onboarding?.step, "ai");
  assert.equal(s.onboardingOpen, true);

  // A step that no longer exists resumes at the beginning rather than a blank screen.
  const before = useApp.getState().onboarding?.step;
  useApp.getState().goToOnboardingStep("nonsense" as never);
  assert.equal(useApp.getState().onboarding?.step, before, "an unknown step is refused rather than stored");
});

test("Start reading finishes setup and Run setup again brings it back at the first step", async () => {
  const { useApp } = await import("./store");
  onboardingRow = { step: "done", done: false, clientsPath: "/tmp/oauth-clients.json" };
  useApp.setState({ status: { accounts, configPath: "", configError: null } });
  await useApp.getState().loadOnboarding();
  assert.equal(useApp.getState().onboardingOpen, true);

  useApp.getState().finishOnboarding();
  await settle();
  let s = useApp.getState();
  assert.equal(s.onboardingOpen, false, "the flow gives the window back");
  assert.equal(onboardingRow.done, true);
  assert.notEqual(s.scope, "setup");

  // A launch after that never reopens the flow.
  useApp.setState({ onboarding: null, onboardingOpen: false });
  await useApp.getState().loadOnboarding();
  assert.equal(useApp.getState().onboardingOpen, false);
  assert.equal(useApp.getState().onboarding?.step, "done");

  useApp.getState().openSettings();
  useApp.getState().reopenOnboarding();
  await settle();
  s = useApp.getState();
  assert.equal(s.onboardingOpen, true);
  assert.equal(s.settingsOpen, false, "Settings closes so the flow is not behind an overlay");
  assert.equal(s.onboarding?.step, "welcome");
  assert.equal(onboardingRow.done, false);
  assert.equal(onboardingRow.step, "welcome");
});

test("adding an account sends the credentials once and gets an accounts status back, never the secret", async () => {
  const { useApp } = await import("./store");
  addedAccounts.length = 0;
  useApp.setState({ onboarding: { step: "accounts", done: false, clientsPath: "/tmp/oauth-clients.json" }, onboardingOpen: true });
  const ok = await useApp.getState().addOnboardingAccount({ email: "you@example.com", consent: "internal", clientId: "123456789012-abc.apps.googleusercontent.com", clientSecret: "a-secret" });
  assert.deepEqual(ok, { ok: true });
  assert.equal(addedAccounts.length, 1);
  assert.equal(addedAccounts[0]?.["clientSecret"], "a-secret");
  assert.equal(JSON.stringify(useApp.getState().status).includes("a-secret"), false, "nothing that came back carries the secret");

  failNext.set("onboarding:addAccount", "that client id is already used by another account here");
  const bad = await useApp.getState().addOnboardingAccount({ email: "two@example.com", consent: "external", clientId: "123456789012-abc.apps.googleusercontent.com", clientSecret: "b" });
  assert.deepEqual(bad, { ok: false, error: "that client id is already used by another account here" });
  const after = useApp.getState();
  assert.equal(after.onboardingOpen, true, "a refused account never closes the flow");
  assert.equal(after.onboarding?.step, "accounts", "and never advances it on its own");
});

// ---- attachments -----------------------------------------------------------------------

test("an attachment chip marks itself busy while the fetch runs, refuses a second press, and clears when it is done", async () => {
  const { attachmentBusyId, useApp } = await import("./store");
  const id = attachmentBusyId("arcforma", "m-k4", "1");
  attachmentDelay = 40;
  useApp.setState({ attachmentsBusy: [] });
  const first = useApp.getState().previewAttachment("arcforma", "m-k4", "1");
  await settle();
  assert.deepEqual(useApp.getState().attachmentsBusy, [id], "the chip spins while the main process works");

  const before = calls.filter((c) => c.channel === "attachments:preview").length;
  await useApp.getState().previewAttachment("arcforma", "m-k4", "1");
  assert.equal(calls.filter((c) => c.channel === "attachments:preview").length, before, "a second press while it is busy starts nothing");

  await first;
  assert.deepEqual(useApp.getState().attachmentsBusy, [], "and stops spinning when the window has opened");
  attachmentDelay = 0;
});

test("Download says where the copy went; a fetch that fails says why, in a toast, and never leaves a chip spinning", async () => {
  const { attachmentBusyId, useApp } = await import("./store");
  useApp.setState({ attachmentsBusy: [], toast: null });
  await useApp.getState().downloadAttachment("arcforma", "m-k4", "1");
  assert.deepEqual(calls.filter((c) => c.channel === "attachments:download").at(-1)?.args, ["arcforma", "m-k4", "1"]);
  assert.deepEqual(useApp.getState().toast, { eyebrow: "DOWNLOADED", text: "deck.pdf is in your Downloads folder." });

  failNext.set("attachments:preview", "Gmail no longer has this attachment.");
  await useApp.getState().previewAttachment("arcforma", "m-k4", "1");
  assert.deepEqual(useApp.getState().toast, { eyebrow: "ATTACHMENT NOT OPENED", text: "Gmail no longer has this attachment." });
  assert.deepEqual(useApp.getState().attachmentsBusy, [], "a failure clears the chip too");

  failNext.set("attachments:download", "That attachment is not on this message any more.");
  await useApp.getState().downloadAttachment("arcforma", "m-k4", "2");
  assert.equal(useApp.getState().toast?.text, "That attachment is not on this message any more.");
  assert.equal(useApp.getState().attachmentsBusy.includes(attachmentBusyId("arcforma", "m-k4", "2")), false);
});

test("two different attachments fetch at once without either clearing the other's spinner", async () => {
  const { attachmentBusyId, useApp } = await import("./store");
  attachmentDelay = 40;
  useApp.setState({ attachmentsBusy: [] });
  const a = useApp.getState().previewAttachment("arcforma", "m-k4", "1");
  const b = useApp.getState().downloadAttachment("arcforma", "m-k4", "2");
  await settle();
  assert.deepEqual(useApp.getState().attachmentsBusy.sort(), [attachmentBusyId("arcforma", "m-k4", "1"), attachmentBusyId("arcforma", "m-k4", "2")].sort());
  await Promise.all([a, b]);
  assert.deepEqual(useApp.getState().attachmentsBusy, []);
  attachmentDelay = 0;
});

// ---- a long thread opens on its newest message ------------------------------------------

/** A thread of n messages, with the given zero-based positions still unread. */
function longThread(id: string, n: number, unreadAt: number[] = []): ThreadView {
  return {
    thread: { ...summary(id, "Kickoff next week"), messageCount: n },
    messages: Array.from({ length: n }, (_, i) =>
      message(id, `m${i + 1}`, { labelIds: unreadAt.includes(i) ? ["INBOX", "UNREAD"] : ["INBOX"], snippet: `message ${i + 1} of the thread` })
    ),
    bodiesPending: false,
  };
}
threadViews.set("arcforma:t-long", longThread("t-long", 34, [20]));

test("a long thread opens with the newest message expanded and the history folded; the folded ones mount no body, and O opens them all and folds them back", async () => {
  const { useApp } = await import("./store");
  useApp.setState({ status: { accounts, configPath: "", configError: null }, ready: true, open: null, expandedMessages: [], allExpanded: false });
  await useApp.getState().openThreadById("arcforma", "t-long");
  await settle();

  let s = useApp.getState();
  assert.equal(s.open?.messages.length, 34);
  assert.deepEqual(s.expandedMessages, ["m1", "m21", "m34"], "the first, the unread one, and the newest");
  assert.equal(s.allExpanded, false);
  // What the control above the first message says, and what the reading pane will not mount.
  assert.equal(s.open!.messages.length - s.expandedMessages.length, 31);

  useApp.getState().toggleAllMessages();
  s = useApp.getState();
  assert.equal(s.expandedMessages.length, 34, "O opens every message");
  assert.equal(s.allExpanded, true);

  useApp.getState().toggleAllMessages();
  s = useApp.getState();
  assert.deepEqual(s.expandedMessages, ["m1", "m21", "m34"], "and folds them back to how the thread opened");
  assert.equal(s.allExpanded, false);

  // One row at a time: clicking a folded one opens it, clicking the header of an open one folds it again.
  useApp.getState().toggleMessage("m7");
  assert.ok(useApp.getState().expandedMessages.includes("m7"));
  useApp.getState().toggleMessage("m7");
  assert.ok(!useApp.getState().expandedMessages.includes("m7"));

  // Opening another thread starts over rather than carrying the last one's folds.
  await useApp.getState().openThreadById("arcforma", "t-agreement");
  await settle();
  assert.deepEqual(useApp.getState().expandedMessages, ["a1"]);
});

test("a reply that arrives while reading shows open; what was folded stays folded", async () => {
  const { useApp } = await import("./store");
  useApp.setState({ status: { accounts, configPath: "", configError: null }, ready: true, open: null, expandedMessages: [], allExpanded: false });
  threadViews.set("arcforma:t-grow", longThread("t-grow", 6));
  await useApp.getState().openThreadById("arcforma", "t-grow");
  await settle();
  assert.deepEqual(useApp.getState().expandedMessages, ["m1", "m6"]);

  const grown = longThread("t-grow", 7);
  threadViews.set("arcforma:t-grow", grown);
  await useApp.getState().refreshOpen();
  await settle();
  assert.deepEqual(useApp.getState().expandedMessages, ["m1", "m6", "m7"], "the new newest message is open; the one that was being read stays open");
});

// ---- the toast, its timer, and Undo ------------------------------------------------------

test("the toast timer stops while the pointer is on it and picks up the time that was left when it leaves", async () => {
  const { useApp } = await import("./store");
  useApp.getState().showToast({ text: "Marked done.", undo: { kind: "archive", accountId: "arcforma", threadId: "t1", until: Date.now() + 1200, text: "Back in the inbox." } });
  assert.equal(useApp.getState().toastPaused, false);

  await new Promise((r) => setTimeout(r, 200));
  useApp.getState().pauseToast();
  assert.equal(useApp.getState().toastPaused, true);
  await new Promise((r) => setTimeout(r, 1600));
  assert.ok(useApp.getState().toast, "the toast is still there long after it would have gone, so Undo is still clickable");

  useApp.getState().resumeToast();
  assert.equal(useApp.getState().toastPaused, false);
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(useApp.getState().toast, null, "and it goes once the pointer has left");
});

/** The store with one thread under the cursor, its list, and no toast. */
async function withRow(over: Partial<ThreadSummary> = {}) {
  const { useApp } = await import("./store");
  calls.length = 0;
  const row = { ...summary("t-done", "Northwind invoice"), ...over };
  useApp.setState({ status: { accounts, configPath: "", configError: null }, ready: true, rows: [row], selected: 0, open: null, toast: null, view: "inbox", readingPane: false, categories: [] });
  return { useApp, row };
}
const undoOf = (t: { undo?: unknown } | null) => (t?.undo ?? null) as { kind?: string; text?: string; starred?: boolean; to?: unknown } | null;

test("E leaves an Undo that puts the thread back in the inbox, and the follow-up toast says so", async () => {
  const { useApp } = await withRow();
  await useApp.getState().archiveSelected();
  await settle();
  assert.equal(useApp.getState().toast?.text, "Marked done.");
  assert.equal(undoOf(useApp.getState().toast)?.kind, "archive");

  await useApp.getState().undo();
  await settle();
  assert.deepEqual(calls.filter((c) => c.channel === "threads:moveToInbox").at(-1)?.args, ["arcforma", "t-done"]);
  assert.equal(useApp.getState().toast?.text, "Back in the inbox.");
  assert.equal(useApp.getState().toast?.undo ?? null, null, "the follow-up offers nothing to undo again");
});

test("H, S, and the File under select each leave an Undo, and Z is the one path all of them take", async () => {
  const { useApp } = await withRow();
  const wake = Date.now() + 86_400_000;
  await useApp.getState().snoozeSelected(wake);
  await settle();
  assert.equal(undoOf(useApp.getState().toast)?.kind, "snooze");
  await useApp.getState().undo();
  await settle();
  assert.deepEqual(calls.filter((c) => c.channel === "threads:unsnooze").at(-1)?.args, ["arcforma", "t-done"]);
  assert.equal(useApp.getState().toast?.text, "Back in the inbox.");

  await withRow({ starred: false });
  await useApp.getState().starSelected();
  await settle();
  assert.equal(useApp.getState().toast?.text, "Starred.");
  assert.equal(undoOf(useApp.getState().toast)?.starred, false, "undo puts the star back where it was");
  await useApp.getState().undo();
  await settle();
  assert.deepEqual(calls.filter((c) => c.channel === "threads:star").at(-1)?.args, ["arcforma", "t-done", false]);
  assert.equal(useApp.getState().toast?.text, "Star removed.");

  const { useApp: app } = await withRow({ split: "important", type: null, categoryId: null });
  await app.getState().refile({ split: "other", category: "promotions" });
  await settle();
  assert.equal(app.getState().toast?.eyebrow, "FILED");
  assert.deepEqual(undoOf(app.getState().toast)?.to, { split: "important", category: null }, "undo goes back to where it was filed");
  await app.getState().undo();
  await settle();
  assert.deepEqual(calls.filter((c) => c.channel === "classify:refile").at(-1)?.args, ["arcforma", "t-done", { split: "important", category: null }]);
  assert.equal(app.getState().toast?.text, "Filed back under Important.");
});

test("U offers Undo for the part that can be taken back and says plainly when there is none", async () => {
  const { useApp } = await withRow({ canUnsubscribe: true });
  unsubscribeResult = { method: "post", ok: true, archived: true, state: "sent", text: "Unsubscribed from Northwind." };
  await useApp.getState().unsubscribeSelected();
  await settle();
  assert.equal(useApp.getState().toast?.eyebrow, "UNSUBSCRIBED");
  assert.equal(undoOf(useApp.getState().toast)?.kind, "archive");
  await useApp.getState().undo();
  await settle();
  assert.match(useApp.getState().toast?.text ?? "", /^Back in the inbox\./);

  await withRow({ canUnsubscribe: true });
  unsubscribeResult = { method: "open", ok: true, archived: false, state: "opened", text: "The unsubscribe page is open in your browser." };
  await useApp.getState().unsubscribeSelected();
  await settle();
  assert.equal(useApp.getState().toast?.undo ?? null, null, "no button that would do nothing");
  assert.equal(useApp.getState().toast?.noUndo, "A request that has gone out cannot be recalled.");
  unsubscribeResult = { method: "post", ok: true, archived: true, state: "sent", text: "Unsubscribed from Northwind." };
});

test("Shift+E puts a thread back in the inbox: the write, the row leaving the Done list, and the way back out", async () => {
  const { useApp } = await withRow({ inInbox: false });
  useApp.setState({ view: "archive" });
  await useApp.getState().moveToInboxSelected();
  await settle();
  assert.deepEqual(calls.filter((c) => c.channel === "threads:moveToInbox").at(-1)?.args, ["arcforma", "t-done"]);
  assert.deepEqual(useApp.getState().rows, [], "it is not one of the Done rows any more");
  assert.equal(useApp.getState().toast?.text, "Back in the inbox.");
  assert.equal(undoOf(useApp.getState().toast)?.kind, "moveToInbox");

  await useApp.getState().undo();
  await settle();
  assert.deepEqual(calls.filter((c) => c.channel === "threads:archive").at(-1)?.args, ["arcforma", "t-done"]);
  assert.equal(useApp.getState().toast?.text, "Back out of the inbox.");

  // A thread already in the inbox is told so, and nothing is written.
  const { useApp: app } = await withRow({ inInbox: true });
  await app.getState().moveToInboxSelected();
  await settle();
  assert.equal(app.getState().toast?.text, "That thread is already in the inbox.");
  assert.equal(calls.filter((c) => c.channel === "threads:moveToInbox").length, 0);
});
