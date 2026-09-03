// The attachment preview window's page. Its own window, its own tiny policy:
// it shows one file and offers Download and Save as, and that is all it can do.
//
// Nothing here executes an attachment. An image is an <img> pointed at the
// app:// route that serves the cached file; a PDF is an <iframe> at the same
// route, which Chromium's own viewer renders; text is put in a <pre> as text,
// never as markup. Anything else gets a card saying so. There is no way from
// this page to open a file in another app: the person does that themselves,
// after Save as, with their own hand on it.

import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "./bridge";
import { Tooltip } from "./components/Tooltip";
import { bytes } from "./lib/format";
import type { AttachmentDetail, AttachmentSaveResult } from "../shared/types";
import "./app.css";

interface Target {
  accountId: string;
  messageId: string;
  key: string;
}

/** The three ids the window was opened with. The page never learns a path or a Gmail id. */
function targetFromLocation(): Target | null {
  const q = new URLSearchParams(window.location.search);
  const accountId = q.get("account");
  const messageId = q.get("message");
  const key = q.get("key");
  if (!accountId || !messageId || !key) return null;
  return { accountId, messageId, key };
}

type Status = { kind: "loading" } | { kind: "ready"; detail: AttachmentDetail } | { kind: "failed"; error: string };

function Header({ detail, note, onDownload, onSaveAs, busy }: { detail: AttachmentDetail; note: string | null; onDownload: () => void; onSaveAs: () => void; busy: boolean }) {
  return (
    <header className="preview-head">
      <div className="preview-title">
        <div className="preview-name" title={detail.filename}>
          {detail.filename}
        </div>
        <div className="af-mono preview-meta">
          {bytes(detail.size)} · {detail.mimeType || "unknown type"}
          {detail.from ? ` · from ${detail.from}` : ""}
        </div>
      </div>
      {note ? <span className="af-mono preview-note">{note}</span> : null}
      <div className="preview-actions">
        <button
          type="button"
          className="btn btn-nav btn-compact"
          disabled={busy}
          data-tip="Puts a copy in your Downloads folder and shows it in Finder. Nothing is opened."
          onClick={onDownload}
        >
          Download
        </button>
        <button
          type="button"
          className="btn btn-nav btn-compact"
          disabled={busy}
          data-tip="Choose a folder and a name for the copy. Nothing is opened."
          onClick={onSaveAs}
        >
          Save as
        </button>
      </div>
    </header>
  );
}

function Body({ detail }: { detail: AttachmentDetail }) {
  if (detail.kind === "image" && detail.src) {
    return (
      <div className="preview-body preview-image">
        <img src={detail.src} alt={detail.filename} />
      </div>
    );
  }
  if (detail.kind === "pdf") {
    // Nothing to draw: the main process parks Chromium's PDF viewer, in a
    // WebContents of its own with no bridge to anything, over this area.
    return <div className="preview-body preview-pdf" />;
  }
  if (detail.kind === "text") {
    return (
      <div className="preview-body preview-text">
        <pre>{detail.text ?? ""}</pre>
        {detail.truncated ? <div className="af-mono preview-note">This file is longer than the preview shows. Download it to read all of it.</div> : null}
      </div>
    );
  }
  return (
    <div className="preview-body preview-none">
      <div className="preview-card">
        <div className="af-h3">No preview for this kind of file</div>
        <p>
          {detail.mimeType || "This type"} is not one Arcforma Mail renders. Download it or save it somewhere, then open it yourself in whatever you use for it.
        </p>
      </div>
    </div>
  );
}

function Preview() {
  const [target] = useState<Target | null>(() => targetFromLocation());
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!target) {
      setStatus({ kind: "failed", error: "This window was opened without an attachment to show." });
      return;
    }
    let live = true;
    void invoke("attachments:detail", target.accountId, target.messageId, target.key)
      .then((detail) => {
        if (!live) return;
        setStatus({ kind: "ready", detail });
        document.title = detail.filename;
      })
      .catch((err: Error) => live && setStatus({ kind: "failed", error: err.message }));
    return () => {
      live = false;
    };
  }, [target]);

  const run = useCallback(
    (channel: "attachments:download" | "attachments:saveAs") => {
      if (!target) return;
      setBusy(true);
      setNote(null);
      void invoke(channel, target.accountId, target.messageId, target.key)
        .then((r: AttachmentSaveResult) => setNote(r.saved ? `Saved as ${r.filename}` : "Not saved."))
        .catch((err: Error) => setNote(err.message))
        .finally(() => setBusy(false));
    },
    [target]
  );

  // Escape closes the window, the way every other panel in the app does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") window.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (status.kind === "loading") {
    return (
      <div className="preview">
        <div className="preview-drag" />
        <div className="preview-body preview-none">
          <div className="af-mono">Loading</div>
        </div>
      </div>
    );
  }
  if (status.kind === "failed") {
    return (
      <div className="preview">
        <div className="preview-drag" />
        <div className="preview-body preview-none">
          <div className="preview-card">
            <div className="af-h3">This attachment could not be shown</div>
            <p>{status.error}</p>
            <button type="button" className="btn btn-nav btn-compact" data-tip="Closes this window." onClick={() => window.close()}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="preview">
      <div className="preview-drag" />
      <Header detail={status.detail} note={note} busy={busy} onDownload={() => run("attachments:download")} onSaveAs={() => run("attachments:saveAs")} />
      <Body detail={status.detail} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
    <Tooltip />
  </StrictMode>
);
