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
(globalThis as { window?: unknown }).window = {
  arcmail: {
    platform: "test",
    on: () => () => {},
    invoke: async (channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      switch (channel) {
        case "threads:list":
          return { rows: [], nextCursor: null };
        case "sidebar:counts":
          return EMPTY_SIDEBAR_COUNTS;
        case "sidebar:setLayout":
          return undefined;
        case "threads:get": {
          const view = threadViews.get(`${args[0]}:${args[1]}`);
          if (!view) throw new Error(`no fixture thread ${args[0]}:${args[1]}`);
          return { ...view, messages: view.messages.map((m) => ({ ...m })) };
        }
        case "drafts:save": {
          const d = args[0] as ComposeDraft;
          const id = d.draftId ?? nextDraftId++;
          draftRows.set(id, { ...d, draftId: id, updatedAt: Date.now() + id });
          return id;
        }
        case "drafts:list":
          return [...draftRows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
        case "drafts:delete":
          draftRows.delete(args[0] as number);
          return undefined;
        case "compose:send":
          return { id: nextSendId++, sendAt: Date.now() + 10_000, undoUntil: Date.now() + 10_000 };
        case "send:undo":
          return { cancelled: true, draft: { ...(lastSent ?? {}), draftId: null } };
        default:
          return undefined;
      }
    },
  },
};
let lastSent: ComposeDraft | null = null;

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
  return { accountId: "arcforma", id, subject, snippet: "", participants: [], lastMessageAt: 0, sortAt: 0, messageCount: 1, unread: false, starred: false, inInbox: true, hasAttachments: false, split: null, type: null, categoryId: null, wakeAt: null, noReplyBy: null, queue: null };
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
  await useApp.getState().confirmSent();
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
