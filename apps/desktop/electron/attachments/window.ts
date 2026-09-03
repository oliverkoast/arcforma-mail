// The attachment preview window: one frameless window per attachment, sized to
// what it holds, showing the file and nothing else.
//
// It is a separate window rather than a panel in the reading pane on purpose.
// A PDF has to be rendered by Chromium's own viewer, which means plugins on,
// and that is not something the mail UI should be carrying. Keeping it apart
// means the reading pane's window never needs plugins at all.
//
// What the window may do is deliberately tiny:
//   - no node integration, sandboxed, context isolation on
//   - navigation pinned to its own URL (isPreviewNavigation): will-navigate,
//     will-frame-navigate, will-redirect, the window-open handler, and
//     will-attach-webview are all refused for anything else
//   - a stricter CSP than the app's, with no remote origin of any kind
//   - the bytes come from the cache folder through the app:// handler, so no
//     path from this window ever reaches the filesystem directly
//
// A PDF renders in a second WebContents parked under the header rather than in
// a frame of the page. That WebContents has no preload and therefore no bridge
// to the main process at all: the document a stranger sent is rendered by a
// renderer that cannot invoke anything, and its navigation is pinned to the one
// attachment URL it was opened on. The header above it is our page, which does
// have the bridge, and is the only half that can act.
//
// Nothing in either half opens, launches, or hands a file to the system. A
// person who wants the file in another app uses Save as and opens it themselves.

import { BrowserWindow, WebContentsView } from "electron";
import path from "node:path";
import { isPreviewNavigation } from "../navigation.js";
import { log } from "../log.js";
import { previewWindowSize, type PreviewKind } from "./kind.js";
import { attachmentSrc } from "./route.js";

export interface PreviewWindowOptions {
  accountId: string;
  messageId: string;
  key: string;
  kind: PreviewKind;
  filename: string;
  /** Directory holding preload.cjs. */
  electronDir: string;
  /** The Vite dev server origin under `pnpm dev`; the preview page is served from there instead of app://. */
  devUrl?: string | undefined;
}

/** The one page a preview window is ever allowed to be at. */
export function previewUrl(opts: Pick<PreviewWindowOptions, "accountId" | "messageId" | "key" | "devUrl">): string {
  const base = opts.devUrl ? `${opts.devUrl.replace(/\/$/, "")}/preview.html` : "app://mail/preview.html";
  const q = new URLSearchParams({ account: opts.accountId, message: opts.messageId, key: opts.key });
  return `${base}?${q.toString()}`;
}

/**
 * The height the page's header takes, in points. The PDF view is parked under
 * it, so this number and the .preview grid rows in app.css have to agree: the
 * 22 pt drag strip plus the 54 pt header row.
 */
export const PREVIEW_HEADER_HEIGHT = 76;

// The window under construction, so the app-wide web-contents-created hook can
// tell a preview window's contents from the main window's. new BrowserWindow
// fires that event synchronously, so this is set and cleared around the one
// call and never spans an await.
let pending: string[] | null = null;

/** The pinned URLs when a preview window's WebContents is being created, or null when it is any other window. */
export function pendingPreviewUrls(): string[] | null {
  return pending;
}

/** Denies every navigation in a preview window except its own pinned URLs. Attached in place of the app's own guard. */
export function guardPreviewContents(contents: Electron.WebContents, pinnedUrls: readonly string[]): void {
  contents.on("will-attach-webview", (event) => event.preventDefault());
  const deny = (event: { preventDefault(): void }, url: string) => {
    if (isPreviewNavigation(url, pinnedUrls)) return;
    event.preventDefault();
    log("preview", `blocked navigation to ${url.slice(0, 120)}`);
  };
  contents.on("will-navigate", (event, url) => deny(event, url));
  contents.on("will-frame-navigate", (details) => deny(details, details.url));
  contents.on("will-redirect", (event, url) => deny(event, url));
  // A preview window opens nothing, not even in the browser: it is showing a
  // file a stranger sent, and a link out of it is not something to follow.
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}

/** Opens (or refocuses) the preview window for one attachment. */
export function openPreviewWindow(opts: PreviewWindowOptions): BrowserWindow {
  const url = previewUrl(opts);
  const already = openWindows.get(url);
  if (already && !already.isDestroyed()) {
    already.focus();
    void already.webContents.reload();
    return already;
  }
  const size = previewWindowSize(opts.kind);
  pending = [url];
  let win: BrowserWindow;
  try {
    win = new BrowserWindow({
      width: size.width,
      height: size.height,
      minWidth: 360,
      minHeight: 240,
      title: opts.filename,
      frame: false,
      backgroundColor: "#FFFFFF",
      show: false,
      webPreferences: {
        preload: path.join(opts.electronDir, "preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        spellcheck: false,
        // Chromium's PDF viewer is a plugin. It is the only reason this is on,
        // and it is why the preview lives in its own window rather than the
        // mail window, which stays without it.
        plugins: opts.kind === "pdf",
      },
    });
  } finally {
    pending = null;
  }
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => openWindows.delete(url));
  openWindows.set(url, win);
  void win.loadURL(url);
  if (opts.kind === "pdf") attachPdfView(win, attachmentSrc(opts.accountId, opts.messageId, opts.key));
  return win;
}

/**
 * Chromium's PDF viewer, in its own WebContents under the header. No preload,
 * so it holds no bridge to the main process; sandboxed, isolated, and pinned to
 * the one attachment URL it was opened on. Its only capability is drawing.
 */
function attachPdfView(win: BrowserWindow, src: string): void {
  pending = [src];
  let view: WebContentsView;
  try {
    view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        spellcheck: false,
        plugins: true,
      },
    });
  } finally {
    pending = null;
  }
  win.contentView.addChildView(view);
  pdfViews.set(win, view);
  const fit = () => {
    const [width, height] = win.getContentSize();
    view.setBounds({ x: 0, y: PREVIEW_HEADER_HEIGHT, width: width ?? 0, height: Math.max(0, (height ?? 0) - PREVIEW_HEADER_HEIGHT) });
  };
  fit();
  win.on("resize", fit);
  win.on("closed", () => {
    if (!view.webContents.isDestroyed()) view.webContents.close();
  });
  void view.webContents.loadURL(src);
}

const openWindows = new Map<string, BrowserWindow>();
// The PDF viewer's WebContents per window. It is a sibling of the window's own,
// so it has to be reached separately to be photographed or closed.
const pdfViews = new WeakMap<BrowserWindow, WebContentsView>();

/**
 * The WebContents rendering the PDF in this preview window, or null when the
 * window is showing something else. Used by the smoke walk, which photographs
 * one WebContents at a time and would otherwise catch only the header.
 */
export function previewPdfContents(win: BrowserWindow): Electron.WebContents | null {
  const view = pdfViews.get(win);
  return view && !view.webContents.isDestroyed() ? view.webContents : null;
}

/** Closes every open preview window. Used on quit so none outlives the store it reads from. */
export function closePreviewWindows(): void {
  for (const win of openWindows.values()) if (!win.isDestroyed()) win.destroy();
  openWindows.clear();
}
