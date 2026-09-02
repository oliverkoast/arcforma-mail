import { useEffect, useMemo, useState } from "react";
import { invoke, on } from "../bridge";
import { useApp } from "../state/store";
import { listDate } from "../lib/format";
import type { AiErrorCode, ContactCard, ContactEventRef } from "../../shared/types";

function initials(name: string, email: string): string {
  const words = name
    .replace(/[<>"]/g, "")
    .split(/[\s.]+/)
    .filter(Boolean);
  if (words.length >= 2) return `${words[0]![0] ?? ""}${words[words.length - 1]![0] ?? ""}`.toUpperCase();
  if (words.length === 1 && words[0]!.length >= 2) return words[0]!.slice(0, 2).toUpperCase();
  return (email[0] ?? "?").toUpperCase();
}

function when(t: number | null): string {
  if (!t) return "Never";
  return new Date(t).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function eventLine(ev: ContactEventRef): string {
  const d = new Date(ev.startAt);
  return `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function failureEyebrow(code: AiErrorCode): string {
  if (code === "not_logged_in") return "SIGN IN TO CLAUDE CODE";
  if (code === "daemon_down") return "AI DAEMON OFF";
  if (code === "timeout") return "LOOKUP TIMED OUT";
  return "LOOKUP FAILED";
}

type Lookup = { state: "idle" } | { state: "running" } | { state: "failed"; code: AiErrorCode; error: string };

/** The rail for the sender of the open thread: who they are, what we have exchanged, when we meet. */
export function ContactPanel() {
  const open = useApp((s) => s.open);
  const openThreadById = useApp((s) => s.openThreadById);
  const accounts = useApp((s) => s.status.accounts);
  const ownerEmails = useMemo(() => new Set(accounts.map((a) => a.email.toLowerCase())), [accounts]);
  const inbound = open?.messages.find((m) => m.direction === "in" && !ownerEmails.has(m.from.email.toLowerCase()));
  const sender = inbound?.from ?? open?.messages.find((m) => !ownerEmails.has(m.from.email.toLowerCase()))?.from ?? null;
  const email = sender?.email.toLowerCase() ?? null;

  const [card, setCard] = useState<ContactCard | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [lookup, setLookup] = useState<Lookup>({ state: "idle" });

  useEffect(() => {
    if (!email) {
      setCard(null);
      setPhoto(null);
      return;
    }
    let live = true;
    setCard(null);
    setCardError(null);
    setPhoto(null);
    setLookup({ state: "idle" });
    const load = async () => {
      try {
        const c = await invoke("contacts:get", email);
        if (live) {
          setCard(c);
          setCardError(null);
        }
      } catch (err) {
        if (live) setCardError((err as Error).message);
      }
    };
    // The photo is a nicety: it arrives when it arrives and a failure shows initials.
    void load();
    void invoke("contacts:photo", email)
      .then((p) => {
        if (live) setPhoto(p);
      })
      .catch(() => undefined);
    const offThreads = on("threads:changed", () => void load());
    const offCal = on("calendar:changed", () => void load());
    return () => {
      live = false;
      offThreads();
      offCal();
    };
  }, [email]);

  const runLookup = async () => {
    if (!email) return;
    setLookup({ state: "running" });
    const r = await invoke("contacts:lookupWeb", email).catch((err: Error) => ({ ok: false as const, code: "unknown" as const, error: err.message }));
    if (r.ok) {
      setCard((cur) => (cur ? { ...cur, web: r.web } : cur));
      setLookup({ state: "idle" });
    } else {
      setLookup({ state: "failed", code: r.code, error: r.error });
    }
  };

  if (!sender || !email) {
    return (
      <>
        <div className="rail-head">
          <span className="af-mono">Contact</span>
        </div>
        <div className="af-h3">No thread open</div>
        <p className="rail-muted">Open a thread and this panel shows its sender: mail history, meetings, and a web summary for people you actually write with.</p>
        <p className="rail-hint af-mono">Cmd+Shift+I closes this panel</p>
      </>
    );
  }

  const name = card?.name ?? sender.name ?? email;
  const domain = card?.domain ?? email.split("@")[1] ?? "";

  return (
    <>
      <div className="rail-head">
        <span className="af-mono">Contact</span>
      </div>
      <div className="contact-id">
        {photo ? <img className="contact-photo" src={photo} alt="" width={56} height={56} /> : <div className="contact-initials" aria-hidden="true">{initials(name, email)}</div>}
        <div className="contact-who">
          <div className="af-h3 contact-name">{name}</div>
          <div className="contact-email">{email}</div>
          <div className="af-mono contact-company">{domain}</div>
        </div>
      </div>

      {card ? (
        <>
          <dl className="contact-facts">
            <dt>Threads</dt>
            <dd>
              {card.recentThreads.length === 0 ? "None yet" : `${card.twoWayThreads} two-way`}
            </dd>
            <dt>Last from them</dt>
            <dd>{when(card.lastFromAt)}</dd>
            <dt>Last to them</dt>
            <dd>{when(card.lastToAt)}</dd>
          </dl>

          <section className="rail-section">
            <span className="af-mono">Meetings</span>
            {card.nextEvent || card.lastEvent ? (
              <>
                {card.nextEvent ? (
                  <div className="contact-event">
                    <div className="contact-event-main">
                      <span className="contact-event-when">Next: {eventLine(card.nextEvent)}</span>
                      <span className="contact-event-title">{card.nextEvent.summary}</span>
                    </div>
                    {card.nextEvent.joinUrl ? (
                      <a className="btn btn-nav btn-compact cal-join" href={card.nextEvent.joinUrl} target="_blank" rel="noreferrer">
                        Join
                      </a>
                    ) : null}
                  </div>
                ) : null}
                {card.lastEvent ? (
                  <div className="contact-event">
                    <div className="contact-event-main">
                      <span className="contact-event-when">Last: {eventLine(card.lastEvent)}</span>
                      <span className="contact-event-title">{card.lastEvent.summary}</span>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="rail-muted">No calendar events with this address.</p>
            )}
          </section>

          <section className="rail-section">
            <span className="af-mono">Recent threads</span>
            {card.recentThreads.length === 0 ? <p className="rail-muted">Nothing in the local store.</p> : null}
            {card.recentThreads.map((t) => (
              <button
                className={`contact-thread${open?.thread.id === t.threadId && open.thread.accountId === t.accountId ? " is-open" : ""}`}
                key={`${t.accountId}:${t.threadId}`}
                onClick={() => void openThreadById(t.accountId, t.threadId)}
              >
                <span className="contact-thread-subject">{t.subject}</span>
                <span className="contact-thread-meta">
                  {listDate(t.lastMessageAt)}
                  {t.messageCount > 1 ? ` · ${t.messageCount}` : ""}
                </span>
              </button>
            ))}
          </section>

          <section className="rail-section">
            <span className="af-mono">On the web</span>
            {card.web ? (
              <>
                <p className="contact-web">{card.web.text}</p>
                <span className="rail-muted">Looked up {when(card.web.at)}.</span>
              </>
            ) : null}
            {lookup.state === "failed" ? (
              <div className="contact-web-fail">
                <span className="af-mono eyebrow-flag">{failureEyebrow(lookup.code)}</span>
                <span className="rail-muted">{lookup.code === "not_logged_in" ? "Run claude auth login in a terminal, then try again." : lookup.error}</span>
              </div>
            ) : null}
            {card.webEligible ? (
              <button className="btn btn-nav btn-compact" disabled={lookup.state === "running"} onClick={() => void runLookup()}>
                {lookup.state === "running" ? "Looking up" : card.web ? "Look up again" : "Look up on the web"}
              </button>
            ) : (
              <p className="rail-muted">Web lookup opens after three two-way threads with this address. Right now: {card.twoWayThreads}.</p>
            )}
          </section>
        </>
      ) : cardError ? (
        <div className="contact-web-fail">
          <span className="af-mono eyebrow-flag">NOT LOADED</span>
          <span className="rail-muted">{cardError}</span>
        </div>
      ) : (
        <p className="rail-muted">Reading the local store.</p>
      )}
      <p className="rail-hint af-mono">Cmd+Shift+I closes this panel</p>
    </>
  );
}
