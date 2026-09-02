import { useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { invoke } from "../bridge";
import { useApp } from "../state/store";
import type { AccountInfo, LoginItemInfo, SnippetInfo } from "../../shared/types";

function accountEyebrow(a: AccountInfo): string {
  if (a.authState === "ok") return "Signed in";
  if (a.authState === "expired") return "Sign in again";
  return "Signed out";
}

function accountLine(a: AccountInfo): string {
  if (a.error) return a.error;
  if (a.authState === "ok") {
    if (a.syncState === "live") return a.lastSyncAt ? `Live. Last sync ${new Date(a.lastSyncAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.` : "Live.";
    if (a.syncState === "backfill" || a.syncState === "new") return "First sync running.";
    return "Signed in.";
  }
  if (a.authState === "expired") return "Google expired the refresh token (invalid_grant). One sign-in restores it.";
  return a.configured ? "Not connected." : "No OAuth client for this account in oauth-clients.json.";
}

function SignaturePreview({ accountId }: { accountId: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void invoke("compose:signature", accountId)
      .then((sig) => {
        if (live) setHtml(sig);
      })
      .catch(() => {
        if (live) setHtml("");
      });
    return () => {
      live = false;
    };
  }, [accountId]);
  if (html === null) return <span className="settings-help">Reading the signature.</span>;
  if (!html.trim()) return <span className="settings-help">No signature stored. Set one in Gmail and sign in again to pick it up.</span>;
  return <div className="signature-preview" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "script", "iframe", "img"] }) }} />;
}

function AccountsSection() {
  const accounts = useApp((s) => s.status.accounts);
  const configError = useApp((s) => s.status.configError);
  const signIn = useApp((s) => s.signIn);
  const showToast = useApp((s) => s.showToast);
  const [busy, setBusy] = useState<string | null>(null);
  const signOut = async (id: string) => {
    setBusy(id);
    try {
      await invoke("accounts:signOut", id);
      showToast({ text: "Signed out. Local mail stays until the next sign-in." });
    } catch (err) {
      showToast({ eyebrow: "SIGN-OUT FAILED", text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="settings-section">
      <span className="af-mono">Accounts</span>
      {configError ? <p className="settings-help">{configError}</p> : null}
      {accounts.map((a) => (
        <div className="settings-item settings-account" key={a.id}>
          <div className="settings-item-main">
            <span className={`af-mono${a.authState === "expired" ? " eyebrow-flag" : ""}`}>{accountEyebrow(a)}</span>
            <span className="settings-item-name">{a.email}</span>
            <span className="settings-item-text">{accountLine(a)}</span>
            {a.authState === "ok" ? <SignaturePreview accountId={a.id} /> : null}
          </div>
          <div className="settings-item-actions settings-account-actions">
            {a.authState === "ok" ? (
              <button className="btn btn-ghost btn-compact" disabled={busy === a.id} onClick={() => void signOut(a.id)}>
                Sign out
              </button>
            ) : (
              <button
                className="btn btn-sweep btn-compact"
                disabled={!a.configured || busy === a.id}
                onClick={() => {
                  setBusy(a.id);
                  void signIn(a.id).finally(() => setBusy(null));
                }}
              >
                {!a.configured ? "Add client id first" : a.authState === "expired" ? "Sign in again" : "Sign in"}
              </button>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

function StartupSection() {
  const showToast = useApp((s) => s.showToast);
  const [info, setInfo] = useState<LoginItemInfo | null>(null);
  useEffect(() => {
    void invoke("app:loginItem")
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);
  const toggle = async (value: boolean) => {
    try {
      setInfo(await invoke("app:setLoginItem", value));
    } catch (err) {
      // The checkbox keeps the last state that actually took effect.
      showToast({ eyebrow: "STARTUP NOT CHANGED", text: (err as Error).message });
    }
  };
  return (
    <section className="settings-section">
      <span className="af-mono">Startup</span>
      <label className="settings-row">
        <span>
          Open at login
          <span className="settings-help">{info?.supported === false ? "Applies to the packed app. Dev and smoke runs leave Login Items alone." : "Arcforma Mail starts with your Mac so mail and reminders keep arriving."}</span>
        </span>
        <input type="checkbox" checked={info?.openAtLogin ?? true} disabled={info === null} onChange={(e) => void toggle(e.target.checked)} />
      </label>
    </section>
  );
}

/** After the third account connects, open Settings so the accounts list and signatures are the next thing seen. */
function useRouteAfterAllConnected() {
  const accounts = useApp((s) => s.status.accounts);
  const openSettings = useApp((s) => s.openSettings);
  const lastOk = useRef<number | null>(null);
  useEffect(() => {
    // The first populated status only records where things stand; a launch with
    // every account already connected must not open Settings on its own.
    if (accounts.length === 0) return;
    const ok = accounts.filter((a) => a.authState === "ok").length;
    if (lastOk.current !== null && ok === accounts.length && ok > lastOk.current) openSettings();
    lastOk.current = ok;
  }, [accounts, openSettings]);
}

function SendingSection() {
  const settings = useApp((s) => s.settings);
  const saveSettings = useApp((s) => s.saveSettings);
  const aiStatus = useApp((s) => s.aiStatus);
  const [undoSec, setUndoSec] = useState(String(settings.undoWindowSec));
  return (
    <section className="settings-section">
      <span className="af-mono">Sending</span>
      <label className="settings-row">
        <span>Undo window, seconds</span>
        <span className="settings-row-control">
          <input type="number" min={0} max={60} value={undoSec} onChange={(e) => setUndoSec(e.target.value)} />
          <button className="btn btn-nav btn-compact" onClick={() => void saveSettings({ undoWindowSec: Number(undoSec) })}>
            Save
          </button>
        </span>
      </label>
      <label className="settings-row">
        <span>
          Remote images
          <span className="settings-help">Pictures hosted on the sender's servers. Loading them can tell a sender you opened the mail. "Block images" on a message overrides this for that sender.</span>
        </span>
        <select value={settings.remoteImages} onChange={(e) => void saveSettings({ remoteImages: e.target.value as "always" | "known" | "never" })}>
          <option value="always">Load from everyone</option>
          <option value="known">Load from people I have written to</option>
          <option value="never">Never load</option>
        </select>
      </label>
      <label className="settings-row">
        <span>
          Auto-draft replies
          <span className="settings-help">R prefills a reply in your voice. Tab accepts it.{aiStatus && !aiStatus.loggedIn ? " Needs a Claude Code sign-in first." : ""}</span>
        </span>
        <input type="checkbox" checked={settings.autoDraft} onChange={(e) => void saveSettings({ autoDraft: e.target.checked })} />
      </label>
    </section>
  );
}

function SnippetForm({ initial, onDone }: { initial: SnippetInfo | null; onDone: () => void }) {
  const saveSnippet = useApp((s) => s.saveSnippet);
  const [trigger, setTrigger] = useState(initial?.trigger ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [text, setText] = useState(initial?.bodyText ?? "");
  const submit = async () => {
    const bodyHtml = text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>`)
      .join("");
    await saveSnippet({ id: initial?.id ?? null, trigger, name, bodyHtml, bodyText: text });
    onDone();
  };
  return (
    <div className="settings-form">
      <label className="compose-field">
        <span className="af-mono">Trigger</span>
        <input value={trigger} onChange={(e) => setTrigger(e.target.value)} placeholder="thanks" spellCheck={false} />
      </label>
      <label className="compose-field">
        <span className="af-mono">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Thanks and next step" />
      </label>
      <label className="compose-field compose-field-tall">
        <span className="af-mono">Text</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="Blank lines make paragraphs." />
      </label>
      <div className="settings-actions">
        <button className="btn btn-sweep btn-compact" disabled={!trigger.trim() || !text.trim()} onClick={() => void submit()}>
          {initial ? "Save changes" : "Add snippet"}
        </button>
        <button className="btn btn-ghost btn-compact" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function SnippetsSection() {
  const snippets = useApp((s) => s.snippets);
  const deleteSnippet = useApp((s) => s.deleteSnippet);
  const [editing, setEditing] = useState<SnippetInfo | null | "new">(null);
  return (
    <section className="settings-section">
      <span className="af-mono">Snippets</span>
      <p className="settings-help">Type ;trigger then Space or Tab in a message. Cmd+; opens the picker.</p>
      {snippets.map((s) => (
        <div className="settings-item" key={s.id}>
          {editing !== "new" && editing?.id === s.id ? (
            <SnippetForm initial={s} onDone={() => setEditing(null)} />
          ) : (
            <>
              <div className="settings-item-main">
                <span className="af-mono">;{s.trigger}</span>
                <span className="settings-item-name">{s.name}</span>
                <span className="settings-item-text">{s.bodyText}</span>
              </div>
              <div className="settings-item-actions">
                <button onClick={() => setEditing(s)}>Edit</button>
                <button onClick={() => void deleteSnippet(s.id)}>Delete</button>
              </div>
            </>
          )}
        </div>
      ))}
      {editing === "new" ? (
        <SnippetForm initial={null} onDone={() => setEditing(null)} />
      ) : (
        <button className="btn btn-nav btn-compact" onClick={() => setEditing("new")}>
          Add snippet
        </button>
      )}
    </section>
  );
}

function CategoriesSection() {
  const categories = useApp((s) => s.categories);
  const createCategory = useApp((s) => s.createCategory);
  const updateCategory = useApp((s) => s.updateCategory);
  const deleteCategory = useApp((s) => s.deleteCategory);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPrompt, setEditPrompt] = useState("");
  const custom = categories.filter((c) => c.kind === "custom");
  return (
    <section className="settings-section">
      <span className="af-mono">Categories</span>
      <p className="settings-help">Name a category and describe in one sentence what belongs there. The local model files matching mail into it and the last 30 days are re-sorted.</p>
      {custom.map((c) => (
        <div className="settings-item" key={c.id}>
          <div className="settings-item-main">
            <span className="settings-item-name">{c.name}</span>
            {editingId === c.id ? (
              <span className="settings-row-control">
                <input value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} />
                <button
                  className="btn btn-nav btn-compact"
                  onClick={() => {
                    void updateCategory(c.id, { prompt: editPrompt });
                    setEditingId(null);
                  }}
                >
                  Save
                </button>
              </span>
            ) : (
              <span className="settings-item-text">{c.prompt || "No description yet."}</span>
            )}
          </div>
          <div className="settings-item-actions">
            <button
              onClick={() => {
                setEditingId(c.id);
                setEditPrompt(c.prompt);
              }}
            >
              Edit
            </button>
            <button onClick={() => void deleteCategory(c.id)}>Delete</button>
          </div>
        </div>
      ))}
      <div className="settings-form">
        <label className="compose-field">
          <span className="af-mono">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Clients" />
        </label>
        <label className="compose-field">
          <span className="af-mono">What belongs</span>
          <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Mail from paying clients about their engagement." />
        </label>
        <div className="settings-actions">
          <button
            className="btn btn-sweep btn-compact"
            disabled={!name.trim() || !prompt.trim()}
            onClick={() => {
              void createCategory(name, prompt);
              setName("");
              setPrompt("");
            }}
          >
            Add category and re-sort 30 days
          </button>
        </div>
      </div>
    </section>
  );
}

export function Settings() {
  const open = useApp((s) => s.settingsOpen);
  const closeSettings = useApp((s) => s.closeSettings);
  const aiStatus = useApp((s) => s.aiStatus);
  useRouteAfterAllConnected();
  if (!open) return null;
  return (
    <div className="overlay" onClick={closeSettings}>
      <section className="panel settings" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <span className="af-mono">Settings · Cmd+,</span>
          <button onClick={closeSettings}>Close (Esc)</button>
        </div>
        <div className="ai-line">
          <span className="af-mono">{aiStatus ? (aiStatus.ok ? (aiStatus.loggedIn ? "Claude signed in" : "Sign in to Claude Code") : "AI daemon off") : "AI status unknown"}</span>
          <span className="settings-help">{aiStatus?.ok ? `Local model ${aiStatus.local}; Claude ${aiStatus.claude}${aiStatus.cliVersion ? ` (${aiStatus.cliVersion})` : ""}.` : "Background sorting and Claude features wait until the daemon runs."}</span>
        </div>
        <AccountsSection />
        <SendingSection />
        <StartupSection />
        <SnippetsSection />
        <CategoriesSection />
      </section>
    </div>
  );
}
