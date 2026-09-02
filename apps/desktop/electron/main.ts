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
import { emit } from "./events.js";
import { applyLoginItem, registerAccountIpc } from "./ipc/accounts.js";
import { registerAiIpc } from "./ipc/ai.js";
import { registerCalendarIpc } from "./ipc/calendar.js";
import { registerComposeIpc } from "./ipc/compose.js";
import { registerContactIpc } from "./ipc/contacts.js";
import { registerSchedulerIpc } from "./ipc/scheduler.js";
import { registerSearchIpc } from "./ipc/search.js";
import { registerSidebarIpc } from "./ipc/sidebar.js";
import { registerThreadIpc } from "./ipc/threads.js";
import { log, logError } from "./log.js";
import { isAllowedNavigation, isExternalLink } from "./navigation.js";
import { dbPath } from "./paths.js";
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

// The package is named "desktop"; without this the data folder would be Application Support/desktop.
app.setName("Arcforma Mail");
if (!process.env["ARCMAIL_USER_DATA"]) app.setPath("userData", path.join(app.getPath("appData"), "Arcforma Mail"));
if (process.env["ARCMAIL_USER_DATA"]) app.setPath("userData", process.env["ARCMAIL_USER_DATA"]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } }]);
  // Every WebContents the app ever creates (the window, any future one) gets
  // the same policy: no webviews, no navigation off the app origin in any frame.
  app.on("web-contents-created", (_event, contents) => guardContents(contents));
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
let classifier: Classifier | null = null;
let calendar: CalendarSync | null = null;
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
    const file = path.normalize(path.join(DIST, pathname));
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return new Response("Not found", { status: 404 });
    }
    const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    const headers: Record<string, string> = { "Content-Type": type, "X-Content-Type-Options": "nosniff" };
    // The same policy as the meta tag in index.html, as a response header so it holds for the whole app:// origin.
    if (type.startsWith("text/html")) headers["Content-Security-Policy"] = APP_CSP;
    return net.fetch(pathToFileURL(file).toString()).then((res) => new Response(res.body, { status: res.status, headers }));
  });
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
  win.once("ready-to-show", () => win.show());
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
  serveDist();

  db = openStore(dbPath());
  log("app", `store at ${dbPath()}`);
  accounts = new AccountRegistry(db);
  accounts.reloadConfig();
  if (accounts.configError) log("app", accounts.configError);
  sync = new SyncManager(db, accounts);
  scheduler = new Scheduler(db, accounts, sync);
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
  registerThreadIpc(db, accounts, sync);
  registerSearchIpc(db);
  registerSidebarIpc(db);
  registerSchedulerIpc(db, scheduler, sync);
  registerComposeIpc(db, scheduler);
  registerAiIpc(db, ai, SMOKE_DIR ? null : classifier, sync);
  registerCalendarIpc(db, SMOKE_DIR ? null : calendar);
  registerContactIpc(contacts);
  const login = applyLoginItem(db);
  log("app", `login item ${login.supported ? (login.openAtLogin ? "on" : "off") : "not managed in this run"}`);

  mainWindow = createWindow();
  if (SMOKE_DIR) {
    runSmoke(mainWindow, SMOKE_DIR, { db, accounts });
  } else {
    sync.start();
    scheduler.start();
    classifier.start();
    calendar.start();
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
  app.on("before-quit", () => {
    sync?.stop();
    scheduler?.stop();
    classifier?.stop();
    calendar?.stop();
    db?.close();
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

const SMOKE_STEPS: Array<{ name: string; script: string | null; main?: (ctx: SmokeContext) => void; waitMs: number }> = [
  { name: "inbox", script: null, waitMs: 2500 },
  { name: "thread", script: "window.__arcmail.select(0); await window.__arcmail.openSelected();", waitMs: 4000 },
  { name: "snooze", script: "window.__arcmail.setPopover('snooze');", waitMs: 600 },
  { name: "compose", script: "window.__arcmail.setPopover(null); window.__arcmail.openCompose('replyAll');", waitMs: 1200 },
  { name: "ask", script: "window.__arcmail.closeCompose(false); window.__arcmail.openAsk(); await window.__arcmail.runAsk('kickoff invoice');", waitMs: 3500 },
  { name: "calendar", script: "window.__arcmail.closeAsk(); window.__arcmail.toggleRail('calendar');", waitMs: 1500 },
  { name: "availability", script: "window.__arcmailCalendar.showAvailability(true); await new Promise((r) => setTimeout(r, 400)); window.__arcmailCalendar.pickDemo();", waitMs: 1200 },
  { name: "contact", script: "window.__arcmail.toggleRail('contact');", waitMs: 2500 },
  { name: "daily", script: "window.__arcmail.toggleRail('contact'); window.__arcmail.setView('daily');", waitMs: 1500 },
  // E through the queue: each press clears one and advances to the next, until the empty state and its cleared count.
  { name: "daily-empty", script: "for (let i = 0; i < 12 && window.__arcmail.rows.length > 0; i++) { await window.__arcmail.archiveSelected(); await new Promise((r) => setTimeout(r, 300)); }", waitMs: 1500 },
  // The sidebar's add popover, opened from the Inbox group's hover "+" glyph; the buttons are in the DOM whether or not the pointer is over them.
  { name: "sidebar-add", script: "window.__arcmail.setView('inbox'); document.querySelector('.nav-group[data-group=\"inbox\"] .nav-add').click();", waitMs: 1200 },
  { name: "scheduled", script: "window.__arcmail.closeSidebarMenu(); window.__arcmail.setView('scheduled'); await new Promise((r) => setTimeout(r, 600)); window.__arcmail.select(0); await window.__arcmail.openSelected();", waitMs: 2000 },
  { name: "splash", script: "window.__arcmail.setView('drafts');", main: (ctx) => fakeBackfill(ctx, 40, 100), waitMs: 1800 },
];

function runSmoke(win: BrowserWindow, dir: string, ctx: SmokeContext): void {
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  win.webContents.on("console-message", (event) => {
    lines.push(`[${event.level}] ${event.message}`);
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  win.webContents.once("did-finish-load", () => {
    void (async () => {
      let failed = false;
      for (const step of SMOKE_STEPS) {
        try {
          if (step.script) await win.webContents.executeJavaScript(`(async () => { ${step.script} })()`, true);
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
          const image = await win.webContents.capturePage();
          const file = path.join(dir, `${step.name}.png`);
          fs.writeFileSync(file, image.toPNG());
          const size = image.getSize();
          console.log(`SMOKE screenshot ${file} ${size.width}x${size.height}`);
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
