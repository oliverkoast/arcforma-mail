import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow, app, net, powerMonitor, protocol, shell, type WebContents } from "electron";
import { getSetting, openStore, updateAccount, type Db } from "@arcforma/store";
import { AccountRegistry } from "./accounts.js";
import { AiClient } from "./ai/client.js";
import { CalendarSync } from "./calendar.js";
import { Classifier } from "./classify/pipeline.js";
import { Contacts } from "./contacts.js";
import { DraftMirror } from "./drafts/mirror.js";
import { emit } from "./events.js";
import { applyLoginItem, registerAccountIpc } from "./ipc/accounts.js";
import { registerAiIpc } from "./ipc/ai.js";
import { registerCalendarIpc } from "./ipc/calendar.js";
import { registerOnboardingIpc } from "./ipc/onboarding.js";
import { registerComposeIpc } from "./ipc/compose.js";
import { registerContactIpc } from "./ipc/contacts.js";
import { registerSchedulerIpc } from "./ipc/scheduler.js";
import { registerSearchIpc } from "./ipc/search.js";
import { registerSidebarIpc } from "./ipc/sidebar.js";
import { registerThreadIpc } from "./ipc/threads.js";
import { registerAttachmentIpc } from "./ipc/attachments.js";
import { ATTACHMENT_ROUTE } from "./attachments/route.js";
import { attachmentsRoot, resolveInRoot } from "./attachments/paths.js";
import { readCached } from "./attachments/cache.js";
import { serveType } from "./attachments/kind.js";
import { findPart } from "./attachments/service.js";
import { AttachmentReaper } from "./attachments/reaper.js";
import { closePreviewWindows, guardPreviewContents, pendingPreviewUrls, previewPdfContents } from "./attachments/window.js";
import { log, logError } from "./log.js";
import { isAllowedNavigation, isExternalLink } from "./navigation.js";
import { dbPath } from "./paths.js";
import { serviceArmer } from "./receipts/arm.js";
import { ReceiptPoller } from "./receipts/poller.js";
import { ReceiptService } from "./receipts/service.js";
import { Scheduler } from "./scheduler.js";
import { seedFixture } from "./smoke/seed.js";
import { SyncManager } from "./sync.js";
import { USER_ART_ROUTE, findUserArt } from "./user-art.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const DEV_URL = process.env["VITE_DEV_SERVER_URL"];
// Smoke mode: seed a fixture, walk the main screens, save screenshots into
// the given folder, print the renderer console, exit.
const SMOKE_DIR = process.env["ARCMAIL_SMOKE"];
const SMOKE_FIXTURE = process.env["ARCMAIL_FIXTURE"];
// Which walk the smoke run takes: the seeded mailbox by default, or the
// first-run setup flow on a machine with nothing configured.
const SMOKE_FLOW = process.env["ARCMAIL_SMOKE_FLOW"] === "onboarding" ? "onboarding" : "app";

// The package is named "desktop"; without this the data folder would be Application Support/desktop.
app.setName("Arcforma Mail");
if (!process.env["ARCMAIL_USER_DATA"]) app.setPath("userData", path.join(app.getPath("appData"), "Arcforma Mail"));
if (process.env["ARCMAIL_USER_DATA"]) app.setPath("userData", process.env["ARCMAIL_USER_DATA"]);

// The smoke window renders on whatever screen is there. A window another app covers stops presenting frames on
// macOS, and capturePage then waits for a frame that never comes; these switches keep an occluded window painting.
if (SMOKE_DIR) {
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } }]);
  // Every WebContents the app ever creates (the window, any future one) gets
  // the same policy: no webviews, no navigation off the app origin in any frame.
  app.on("web-contents-created", (_event, contents) => {
    // An attachment preview window takes a stricter policy of its own: pinned
    // to one URL, opening nothing, following nothing. openPreviewWindow marks
    // the window it is building, and new BrowserWindow fires this event inside
    // that call, so the mark is never stale.
    const pinned = pendingPreviewUrls();
    if (pinned) guardPreviewContents(contents, pinned);
    else guardContents(contents);
  });
  void boot();
}

/** Denies navigation off the app origin for the main frame and every child frame; http(s) targets go to the browser instead. */
function guardContents(contents: WebContents): void {
  contents.on("will-attach-webview", (event) => event.preventDefault());
  const deny = (event: { preventDefault(): void }, url: string) => {
    if (isAllowedNavigation(url, { devUrl: DEV_URL })) return;
    event.preventDefault();
    if (isExternalLink(url)) void shell.openExternal(url);
    else log("nav", `blocked navigation to ${url.slice(0, 120)}`);
  };
  contents.on("will-navigate", (event, url) => deny(event, url));
  contents.on("will-frame-navigate", (details) => deny(details, details.url));
  contents.on("will-redirect", (event, url) => deny(event, url));
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalLink(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

let db: Db | null = null;
let accounts: AccountRegistry | null = null;
let sync: SyncManager | null = null;
let scheduler: Scheduler | null = null;
let mirror: DraftMirror | null = null;
let classifier: Classifier | null = null;
let calendar: CalendarSync | null = null;
let reaper: AttachmentReaper | null = null;
let mainWindow: BrowserWindow | null = null;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

// Message bodies render in srcdoc iframes, which inherit this policy and add
// their own stricter one on top. img-src must allow https here or the
// per-sender "Load images" toggle can never load anything.
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'nonce-arcmail'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: http: cid:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' about: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

// The attachment preview window is stricter than the app: no remote origin of
// any kind, no data: frames, and images only from this origin (the cache folder
// through the attachment route). A file a stranger sent renders here, so it gets
// the smallest policy that still shows it.
const PREVIEW_CSP = [
  "default-src 'self'",
  "script-src 'self' 'nonce-arcmail'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function serveDist(): void {
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/" || pathname === "") pathname = "/index.html";
    // User-supplied art lives in the data folder, not in dist: app://mail/user-art/inbox-zero.
    if (pathname.startsWith(USER_ART_ROUTE)) {
      const art = findUserArt(app.getPath("userData"), pathname.slice(USER_ART_ROUTE.length));
      if (!art) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(art.file).toString()).then((res) => new Response(res.body, { status: res.status, headers: { "Content-Type": art.type, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache" } }));
    }
    // Cached attachment bytes: app://mail/attachment/<account>/<message>/<key>.
    // The path is never in the URL. The three ids are resolved against the
    // store, the cache row is read, and the file is resolved and checked
    // against the attachments root before it is opened, so a crafted URL can
    // only ever reach a file this app itself wrote for a message it holds.
    // Only images and PDFs are served as themselves; anything else comes back
    // as octet-stream with nosniff, so nothing here can be run by the renderer.
    if (url.pathname.startsWith(ATTACHMENT_ROUTE)) {
      // The raw pathname, not the once-decoded one: each segment is decoded
      // exactly once inside, so no %252e can become a "." on a second pass.
      return serveAttachment(url.pathname.slice(ATTACHMENT_ROUTE.length));
    }
    const file = path.normalize(path.join(DIST, pathname));
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return new Response("Not found", { status: 404 });
    }
    const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    const headers: Record<string, string> = { "Content-Type": type, "X-Content-Type-Options": "nosniff" };
    // The same policy as the meta tag in index.html, as a response header so it holds for the whole app:// origin.
    if (type.startsWith("text/html")) headers["Content-Security-Policy"] = pathname === "/preview.html" ? PREVIEW_CSP : APP_CSP;
    return net.fetch(pathToFileURL(file).toString()).then((res) => new Response(res.body, { status: res.status, headers }));
  });
}

/** Serves one cached attachment. Every step is a check: the ids, the cache row, and the resolved path against the root. */
function serveAttachment(rest: string): Promise<Response> | Response {
  const parts = rest.split("/").map((p) => decodeURIComponent(p));
  if (!db || parts.length !== 3) return new Response("Not found", { status: 404 });
  const [accountId, messageId, key] = parts as [string, string, string];
  const found = findPart(db, accountId, messageId, key);
  if (!found || (found.kind !== "image" && found.kind !== "pdf")) return new Response("Not found", { status: 404 });
  const root = attachmentsRoot(app.getPath("userData"));
  const cached = readCached(db, root, accountId, messageId, key);
  if (!cached) return new Response("Not cached", { status: 404 });
  let file: string;
  try {
    file = resolveInRoot(root, cached.path);
  } catch {
    log("attachments", `refused a cached path outside the attachments folder for ${accountId}/${messageId}`);
    return new Response("Not found", { status: 404 });
  }
  return net.fetch(pathToFileURL(file).toString()).then(
    (res) =>
      new Response(res.body, {
        status: res.status,
        headers: {
          "Content-Type": serveType(cached.mimeType, cached.filename),
          // nosniff is what stops these bytes being read as anything but the
          // type serveType chose. Everything that is not an image or a PDF is
          // octet-stream, which the renderer cannot render or run at all.
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        },
      })
  );
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: "Arcforma Mail",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: "#FFFFFF",
    show: false,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: true,
    },
  });
  // A smoke run captures from a window that is never shown. capturePage paints an offscreen window
  // on its own, so showing one buys nothing and costs the person at the keyboard their screen: the
  // window used to appear full of seeded demo mail, take focus, and sit on top of real work.
  win.once("ready-to-show", () => {
    if (!SMOKE_DIR) win.show();
  });
  // Navigation and window-open policy is attached in guardContents via web-contents-created.
  win.on("focus", () => sync?.setFocused(true));
  win.on("blur", () => sync?.setFocused(false));
  win.on("closed", () => {
    mainWindow = null;
  });
  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadURL("app://mail/index.html");
  return win;
}

async function boot(): Promise<void> {
  await app.whenReady();
  app.setName("Arcforma Mail");
  // A smoke run is a background process that happens to render. No dock icon, no activation, no
  // stealing the frontmost app from whoever is working while it runs.
  if (SMOKE_DIR) app.dock?.hide();
  serveDist();

  const file = dbPath();
  db = openStore(file);
  log("app", `store at ${file}`);
  accounts = new AccountRegistry(db);
  accounts.reloadConfig();
  if (accounts.configError) log("app", accounts.configError);
  sync = new SyncManager(db, accounts);
  // Read receipts: off by default, per message, and honest about the difference
  // between no fetch and unread. docs/adr/0003 says why they exist at all.
  const receiptService = new ReceiptService(db);
  const receipts = new ReceiptPoller(db, receiptService, {
    onPoll: (r) => { if (r.received > 0) log("receipts", `${r.received} event(s), ${r.written} new, watermark ${new Date(r.watermark).toISOString()}`); },
    onError: (err) => logError("receipts", "poll", err),
  });
  scheduler = new Scheduler(db, accounts, sync, { receipts });
  mirror = new DraftMirror(db, sync);
  const ai = new AiClient();
  if (!ai.reload()) log("ai", "daemon config missing; AI features report daemon_down until packages/ai-daemon/install.sh runs");
  const registry = accounts;
  const store = db;
  classifier = new Classifier(
    db,
    ai,
    () => registry.list().flatMap((a) => registry.ownerAddresses(a.id)),
    (ids) => {
      for (const id of ids) emit("threads:changed", { accountId: id });
    }
  );
  sync.onThreadsChanged = () => classifier?.poke();
  calendar = new CalendarSync(db, accounts);
  const contacts = new Contacts(db, accounts, ai);
  // Photos were fetched with whichever account's token was live; after a sign-out they are looked up afresh.
  accounts.onSignedOut = () => contacts.forgetPhotos();

  if (SMOKE_DIR && SMOKE_FIXTURE) {
    const seeded = seedFixture(store, SMOKE_FIXTURE);
    log("smoke", `seeded ${seeded.threads} threads and ${seeded.events} calendar events from ${SMOKE_FIXTURE}`);
  }

  registerAccountIpc(accounts, sync, db);
  registerThreadIpc(db, accounts, sync, scheduler);
  registerAttachmentIpc(db, accounts, { electronDir: here, devUrl: DEV_URL });
  reaper = new AttachmentReaper(db, attachmentsRoot(app.getPath("userData")));
  registerSearchIpc(db);
  registerSidebarIpc(db);
  registerSchedulerIpc(db, scheduler, sync);
  registerComposeIpc(db, scheduler, mirror, sync, { armer: serviceArmer(db, receiptService), service: receiptService, storePath: file });
  registerAiIpc(db, ai, SMOKE_DIR ? null : classifier, sync);
  registerCalendarIpc(db, SMOKE_DIR ? null : calendar);
  registerContactIpc(contacts);
  registerOnboardingIpc(db, accounts, sync, ai);
  const login = applyLoginItem(db);
  log("app", `login item ${login.supported ? (login.openAtLogin ? "on" : "off") : "not managed in this run"}`);

  mainWindow = createWindow();
  if (SMOKE_DIR) {
    runSmoke(mainWindow, SMOKE_DIR, { db, accounts });
  } else {
    sync.start();
    // Drafts saved in the last moments before the previous quit read Saving with nothing queued; queue them now.
    const recovered = mirror.recover();
    if (recovered) log("drafts", `queued ${recovered} draft(s) left pending by the last run`);
    scheduler.start();
    classifier.start();
    calendar.start();
    // Attachments of messages deleted while the app was closed go now; the rest on the sweep.
    reaper.start();
    // A store that has never seen activity starts its day now, so Daily 0 holds today's mail and not every important thread.
    if (getSetting(db, "lastActiveAt") === 0) scheduler.noteActivity(Date.now());
  }

  powerMonitor.on("resume", () => {
    sync?.pokeAll();
    void calendar?.runAll();
    // Opening the lid counts as activity: the morning rollover should be done before the first keystroke.
    if (!SMOKE_DIR) scheduler?.noteActivity(Date.now());
  });
  powerMonitor.on("unlock-screen", () => sync?.pokeAll());

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    // A draft edited in the last two seconds is queued now; the outbox row survives the quit and drains on the next start.
    // The flush builds the message asynchronously, so the quit waits for it (briefly) before the store closes under it.
    quitting = true;
    event.preventDefault();
    void (async () => {
      try {
        await Promise.race([mirror?.flush(), new Promise((r) => setTimeout(r, 3000))]);
      } catch (err) {
        logError("drafts", "flush before quit", err);
      }
      mirror?.stop();
      // No preview window may outlive the store it reads its file from.
      closePreviewWindows();
      reaper?.stop();
      sync?.stop();
      scheduler?.stop();
      classifier?.stop();
      calendar?.stop();
      db?.close();
      db = null;
      app.quit();
    })();
  });
}

interface SmokeContext {
  db: Db;
  accounts: AccountRegistry;
}

/** Pretend one account is 40 percent through its backfill so the splash renders with real progress events. */
function fakeBackfill(ctx: SmokeContext, done: number, total: number): void {
  updateAccount(ctx.db, "arcforma", { sync_state: "backfill", backfill_done: done, backfill_total: total });
  emit("accounts:changed", ctx.accounts.status());
  emit("sync:progress", { accountId: "arcforma", state: "backfill", done, total, finished: false });
}

interface SmokeStep {
  name: string;
  script: string | null;
  main?: (ctx: SmokeContext) => void;
  hover?: string;
  waitMs: number;
  /** Photograph the attachment preview window with this title instead of the mail window. */
  previewTitle?: string;
  /** For a PDF preview, photograph the viewer's own WebContents rather than the window's header. */
  previewPdf?: boolean;
  /** Close every preview window after the shot, so the next step opens a fresh one. */
  closePreviews?: boolean;
}

const SMOKE_STEPS: SmokeStep[] = [
  { name: "inbox", script: null, waitMs: 2500 },
  // Settings, scrolled to read receipts: the only place the feature can be turned on, and so the
  // only place that has to say what a receipt cannot tell you.
  {
    name: "settings-receipts",
    script:
      "window.__arcmail.openSettings(); await new Promise((r) => setTimeout(r, 500)); const h = [...document.querySelectorAll('.settings-section .af-mono')].find((e) => e.textContent === 'Read receipts'); h?.closest('.settings-section')?.scrollIntoView({ block: 'center' });",
    waitMs: 700,
  },
  { name: "settings-closed", script: "window.__arcmail.closeSettings();", waitMs: 400 },
  // Cmd+K with "sno" typed: the snooze commands rank first, their keys in mono on the right.
  { name: "palette", script: "window.__arcmail.openPalette(); await new Promise((r) => setTimeout(r, 300)); window.__arcmail.setPaletteQuery('sno');", waitMs: 900 },
  // An empty focused search field shows the operator hint under it. The smoke window has no OS focus, so focus events never fire; the scope is set the way onFocus would.
  { name: "search-hint", script: "window.__arcmail.closePalette(); document.getElementById('search-input').focus(); window.__arcmail.setScope('search'); await new Promise((r) => setTimeout(r, 400));", waitMs: 600 },
  // Operators in the query: the hits show the matched field as an eyebrow with the hit term marked.
  { name: "search-ops", script: "window.__arcmail.setSearchQuery('from:dana has:attachment'); await window.__arcmail.runSearch();", waitMs: 1200 },
  { name: "thread", script: "window.__arcmail.leaveSearch(); await new Promise((r) => setTimeout(r, 800)); window.__arcmail.select(0); await window.__arcmail.openSelected();", waitMs: 4000 },
  // The bottom of the "Kickoff next week" thread: the reply row under the last message, no draft anywhere.
  { name: "thread-reply-row", script: "document.querySelector('.messages').scrollTop = 1e6;", waitMs: 600 },
  // The last message carries a gateway banner and quotes Priya's mail under a Gmail attribution: the banner is gone and the history sits behind Show quoted text.
  { name: "quote-folded", script: "document.querySelector('.message.is-last').scrollIntoView({ block: 'start' });", waitMs: 600 },
  // Show quoted text: the details opens inside the sandboxed frame and the frame grows to fit.
  { name: "quote-expanded", script: "document.querySelector('.message.is-last iframe').contentDocument.querySelector('details.quote-fold').open = true; await new Promise((r) => setTimeout(r, 400)); document.querySelector('.message.is-last').scrollIntoView({ block: 'start' });", waitMs: 800 },
  // R: the inline reply docked under the last message, with a few words typed so the strip has something to show.
  { name: "inline-reply", script: "document.querySelector('.message.is-last iframe').contentDocument.querySelector('details.quote-fold').open = false; window.__arcmail.openCompose('reply'); await new Promise((r) => setTimeout(r, 500)); window.__arcmail.editorApi.setHtml('<p>Priya should join the first session. The plan goes out tonight.</p>');", waitMs: 1200 },
  // Esc: the box collapses to its one-line strip and the keys go back to the thread.
  { name: "inline-strip", script: "await window.__arcmail.dismissCompose();", waitMs: 800 },
  // Reply from a message in the middle of the thread: the box moves under it, recipients come from that message, the typed text comes along.
  { name: "inline-reply-mid", script: "window.__arcmail.openCompose('reply', { messageId: 'm-k6' }); await new Promise((r) => setTimeout(r, 400)); document.querySelector('.inline-reply').scrollIntoView({ block: 'center' });", waitMs: 1200 },
  // The pointer rests on the Mark done icon for longer than the tooltip delay: the card sits under it with the E hint.
  { name: "tooltip-mark-done", script: null, hover: ".reading-actions .icon-btn[data-glyph='done']", waitMs: 900 },
  // Daily 0 in the sidebar: the row answers what it contains.
  { name: "tooltip-daily", script: null, hover: ".nav-row[data-row-id='daily'] .nav-item", waitMs: 900 },
  // The Inbox group with all six types: Newsletters, Promotions, and Jobs above the older three,
  // each with its count, and the Jobs row saying what it holds.
  { name: "sidebar-types", script: null, hover: ".nav-row[data-row-id='category:jobs'] .nav-item", waitMs: 900 },
  { name: "snooze", script: "window.__arcmail.setPopover('snooze');", hover: ".list-head", waitMs: 600 },
  // C over an inline reply parks the reply as a draft and opens the floating panel.
  { name: "compose", script: "window.__arcmail.setPopover(null); window.__arcmail.openCompose('new');", waitMs: 1200 },
  { name: "ask", script: "window.__arcmail.closeCompose(false); window.__arcmail.openAsk(); await window.__arcmail.runAsk('kickoff invoice');", waitMs: 3500 },
  { name: "calendar", script: "window.__arcmail.closeAsk(); window.__arcmail.toggleRail('calendar');", waitMs: 1500 },
  { name: "availability", script: "window.__arcmailCalendar.showAvailability(true); await new Promise((r) => setTimeout(r, 400)); window.__arcmailCalendar.pickDemo();", waitMs: 1200 },
  { name: "contact", script: "window.__arcmail.toggleRail('contact');", waitMs: 2500 },
  // The Needs you row at the head of the Queues group, with its count and the sentence that says what it holds.
  { name: "needs-you-row", script: "window.__arcmail.toggleRail('contact'); window.__arcmail.setView('inbox');", hover: ".nav-row[data-row-id='needsyou'] .nav-item", waitMs: 1200 },
  // The list itself: each row leads with the mono reason eyebrow saying who asked and how long it has waited.
  // The pointer moves off the sidebar so the row shows its count rather than its hover controls.
  { name: "needs-you-list", script: "window.__arcmail.setView('needsyou');", hover: ".list-head", waitMs: 1500 },
  { name: "daily", script: "window.__arcmail.setView('daily');", waitMs: 1500 },
  // E through the queue: each press clears one and advances to the next, until the empty state and its cleared count.
  { name: "daily-empty", script: "for (let i = 0; i < 12 && window.__arcmail.rows.length > 0; i++) { await window.__arcmail.archiveSelected(); await new Promise((r) => setTimeout(r, 300)); }", waitMs: 1500 },
  // The sidebar's add popover, opened from the Inbox group's hover "+" glyph; the buttons are in the DOM whether or not the pointer is over them.
  { name: "sidebar-add", script: "window.__arcmail.setView('inbox'); document.querySelector('.nav-group[data-group=\"inbox\"] .nav-add').click();", waitMs: 1200 },
  { name: "scheduled", script: "window.__arcmail.closeSidebarMenu(); window.__arcmail.setView('scheduled'); await new Promise((r) => setTimeout(r, 600)); window.__arcmail.select(0); await window.__arcmail.openSelected();", waitMs: 2000 },
  { name: "splash", script: "window.__arcmail.setView('drafts');", main: (ctx) => fakeBackfill(ctx, 40, 100), waitMs: 1800 },
  // The recipient line opened: every address on the message, grouped To and Cc, with the owner's own read as "you".
  { name: "message-recipients", script: "window.__arcmail.setView('inbox'); await new Promise((r) => setTimeout(r, 600)); await window.__arcmail.openThreadById('arcforma', 't-kickoff'); await new Promise((r) => setTimeout(r, 1500)); document.querySelector('.message.is-last .message-to').click(); document.querySelector('.message.is-last').scrollIntoView({ block: 'start' });", waitMs: 1000 },
  // The two attachments on the message Oliver sent: each chip is a button that
  // previews, with a Download glyph that appears under the pointer.
  {
    name: "attachments",
    // The files hang off a message in the middle of the thread, which now opens folded; opening it is what a reader would do.
    script: "window.__arcmail.setView('inbox'); await new Promise((r) => setTimeout(r, 600)); await window.__arcmail.openThreadById('arcforma', 't-kickoff'); await new Promise((r) => setTimeout(r, 1500)); window.__arcmail.toggleMessage('m-k4'); await new Promise((r) => setTimeout(r, 800)); document.querySelector('.attachments').scrollIntoView({ block: 'center' });",
    hover: ".attachments .attachment",
    waitMs: 1200,
  },
  // The PNG in its own frameless window: the file fitted to the window, with its name, size, and Download and Save as above it.
  {
    name: "attachment-image",
    script: "await window.__arcmail.previewAttachment('arcforma', 'm-k4', '2');",
    waitMs: 2000,
    previewTitle: "Room 2 north light.png",
    closePreviews: true,
  },
  // The PDF in the same shell, rendered by Chromium's own viewer from the cached file.
  {
    name: "attachment-pdf",
    script: "await window.__arcmail.previewAttachment('arcforma', 'm-k4', '1');",
    waitMs: 3000,
    previewTitle: "Session plan.pdf",
    // The PDF renders in a WebContents of its own parked under the header, so
    // that is the one to photograph; the header shell is the same one the image
    // shot above shows.
    previewPdf: true,
    closePreviews: true,
  },
  // A newsletter whose unsubscribe line, postal address, and copyright sit behind one SHOW FOOTER toggle, its tracking pixel gone.
  { name: "footer-folded", script: "await window.__arcmail.openThreadById('formai', 't-vendor'); await new Promise((r) => setTimeout(r, 1500)); document.querySelector('.messages').scrollTop = 0;", waitMs: 1200 },
  // The same message with the footer open: nothing was deleted, it was one click away.
  { name: "footer-expanded", script: "document.querySelector('.message.is-last iframe').contentDocument.querySelector('details.quote-fold').open = true;", waitMs: 1000 },
  // A 34 message thread as it opens: scrolled to the newest message, expanded,
  // with the history above it folded to one row each and no frame behind them.
  { name: "long-thread", script: "window.__arcmail.setView('inbox'); await new Promise((r) => setTimeout(r, 800)); await window.__arcmail.openThreadById('arcforma', 't-history');", waitMs: 3500 },
  // The top of the same thread: the control says how many are folded, with its key.
  { name: "long-thread-control", script: "document.querySelector('.messages').scrollTop = 0;", waitMs: 900 },
  // The control pressed: every message open, in the same chronological order, and the control offering the way back.
  { name: "long-thread-expanded", script: "document.querySelector('.messages-fold').click(); await new Promise((r) => setTimeout(r, 800)); document.querySelector('.messages').scrollTop = 0;", waitMs: 2500 },
  // E on a thread: the confirmation lands bottom left, and the pointer resting on it reveals Undo with its key.
  { name: "toast-undo", script: "window.__arcmail.closeThread(); window.__arcmail.setView('inbox'); await new Promise((r) => setTimeout(r, 900)); window.__arcmail.select(0); await window.__arcmail.archiveSelected();", hover: ".toast", waitMs: 1600 },
  // The Done row in Folders and what it holds: everything E has taken out of the inbox, newest first.
  { name: "done-view", script: "window.__arcmail.showToast(null); window.__arcmail.setView('archive'); await new Promise((r) => setTimeout(r, 700)); document.querySelector('.nav-row[data-row-id=\"archive\"]').scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 300));", hover: ".nav-row[data-row-id='archive'] .nav-item", waitMs: 2000 },
  // A thread opened from Done: the mono DONE eyebrow says where it is, and the tray glyph puts it back.
  { name: "done-thread", script: "window.__arcmail.select(0); await window.__arcmail.openSelected();", hover: ".reading-actions .icon-btn[data-glyph='inbox']", waitMs: 2500 },
];

/**
 * The first-run flow on a machine with nothing set up: every step, plus the
 * account form answering a client id that is not one. Nothing here presses a
 * button that would reach Google, run an installer, or start a download.
 */
const ONBOARDING_SMOKE_STEPS: SmokeStep[] = [
  { name: "onboarding-welcome", script: null, waitMs: 1200 },
  { name: "onboarding-account-empty", script: "window.__arcmail.goToOnboardingStep('accounts');", waitMs: 900 },
  // A client id pasted into the wrong box: the field says what is wrong and nothing is written.
  {
    name: "onboarding-account-error",
    script: `
      const set = (el, v) => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
      const fields = document.querySelectorAll('.setup-card .setup-field input');
      set(fields[0], 'you@example.com');
      set(fields[2], 'this-is-the-secret-not-the-id');
      await new Promise((r) => setTimeout(r, 200));
      [...document.querySelectorAll('.setup-actions .btn')].find((b) => b.textContent.startsWith('Save and sign in')).click();
      await new Promise((r) => setTimeout(r, 200));
      document.querySelector('.setup-error').scrollIntoView({ block: 'center' });
    `,
    waitMs: 900,
  },
  { name: "onboarding-ai", script: "window.__arcmail.goToOnboardingStep('ai');", waitMs: 1500 },
  { name: "onboarding-model", script: "window.__arcmail.goToOnboardingStep('model');", waitMs: 1500 },
  { name: "onboarding-text", script: "window.__arcmail.goToOnboardingStep('text');", waitMs: 1500 },
  { name: "onboarding-done", script: "window.__arcmail.goToOnboardingStep('done');", waitMs: 1200 },
];

/**
 * capturePage resolves with the next presented frame. When nothing presents (the window is covered, or the compositor
 * idles after the resize nudge) it never resolves, so each attempt is bounded: bring the window forward, force a repaint,
 * and try again before giving the step up.
 */
/** One WebContents that is not a window's own (the PDF viewer parked in a preview window). */
async function captureContents(contents: Electron.WebContents, attempts = 3): Promise<Electron.NativeImage> {
  for (let i = 1; ; i++) {
    const image = await Promise.race([contents.capturePage(), new Promise<null>((r) => setTimeout(() => r(null), 8_000))]);
    if (image && image.getSize().width > 0) return image;
    if (i >= attempts) throw new Error(`capturePage produced no frame in ${attempts} attempts`);
    contents.invalidate();
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function captureWithRetry(win: BrowserWindow, attempts = 3): Promise<Electron.NativeImage> {
  for (let i = 1; ; i++) {
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 8_000));
    const image = await Promise.race([win.webContents.capturePage(), timeout]);
    if (image) return image;
    if (i >= attempts) throw new Error(`capturePage produced no frame in ${attempts} attempts`);
    console.log(`SMOKE capture attempt ${i} produced no frame; repainting`);
    win.moveTop();
    win.webContents.invalidate();
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** The open preview window with this title, waited for: it is created by an IPC call and shows a frame or two later. */
async function findPreviewWindow(title: string, mainWin: BrowserWindow): Promise<BrowserWindow> {
  for (let i = 0; i < 40; i++) {
    const win = BrowserWindow.getAllWindows().find((w) => w !== mainWin && !w.isDestroyed() && w.getTitle() === title);
    if (win && !win.webContents.isLoading()) return win;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no preview window titled ${title}`);
}

function runSmoke(win: BrowserWindow, dir: string, ctx: SmokeContext): void {
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  win.webContents.on("console-message", (event) => {
    lines.push(`[${event.level}] ${event.message}`);
  });
  // A preview window is a second renderer; anything it logs counts the same way.
  app.on("browser-window-created", (_e, created) => {
    if (created === win) return;
    created.webContents.on("console-message", (event) => lines.push(`[${event.level}] ${event.message}`));
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  win.webContents.once("did-finish-load", () => {
    void (async () => {
      let failed = false;
      for (const step of SMOKE_FLOW === "onboarding" ? ONBOARDING_SMOKE_STEPS : SMOKE_STEPS) {
        try {
          if (step.script) await win.webContents.executeJavaScript(`(async () => { ${step.script} })()`, true);
          if (step.hover) {
            // Move the real pointer onto the element, the way a hand would, so the tooltip layer's timer starts.
            const at = (await win.webContents.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(step.hover)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`, true)) as { x: number; y: number };
            win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(at.x), y: Math.round(at.y) });
          }
          if (step.main) {
            await sleep(300);
            step.main(ctx);
          }
          await sleep(step.waitMs);
          // capturePage hands back the last presented frame, and after E has torn down message iframes mid-load the
          // renderer stops presenting new ones. A one pixel resize forces a layout and a fresh frame.
          const [w, h] = win.getSize();
          win.setSize(w!, h! + 1);
          await sleep(150);
          win.setSize(w!, h!);
          await sleep(250);
          const target = step.previewTitle ? await findPreviewWindow(step.previewTitle, win) : win;
          if (target !== win) {
            // The preview window has just opened; give it a beat to paint before the capture waits on a frame.
            target.moveTop();
            await sleep(600);
          }
          const contents = step.previewPdf ? previewPdfContents(target) : null;
          if (step.previewPdf && !contents) throw new Error("the preview window has no PDF view to photograph");
          const image = contents ? await captureContents(contents) : await captureWithRetry(target);
          const file = path.join(dir, `${step.name}.png`);
          fs.writeFileSync(file, image.toPNG());
          const size = image.getSize();
          console.log(`SMOKE screenshot ${file} ${size.width}x${size.height}`);
          if (step.closePreviews) {
            closePreviewWindows();
            await sleep(300);
            // No moveTop or focus: nothing in a smoke run may come to the front of someone's screen.
          }
        } catch (err) {
          failed = true;
          logError("smoke", step.name, err);
          console.log(`SMOKE [error] step ${step.name} failed: ${(err as Error).message}`);
        }
      }
      console.log(`SMOKE console lines: ${lines.length}`);
      for (const l of lines) console.log(`SMOKE ${l}`);
      app.exit(failed ? 1 : 0);
    })();
  });
  win.webContents.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
    // A message-body iframe torn down mid-load (E advancing through a queue) reports ERR_ABORTED; only the app page itself failing is fatal.
    if (!isMainFrame || code === -3) return;
    console.log(`SMOKE load failed ${code} ${desc}`);
    app.exit(1);
  });
}
