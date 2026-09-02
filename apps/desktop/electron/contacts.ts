// Contact rail data: the card comes straight from the store, the photo is
// resolved once per address (People API, Gravatar, then initials) and handed
// to the renderer as a data: URL because the page CSP allows no remote images,
// and the web lookup goes through Claude with WebSearch only for people Oliver
// actually corresponds with.

import { resolvePhoto } from "@arcforma/gmail";
import { contactName, contactStats, eventsWithAttendee, getContact, listAccounts, setContactPhoto, setContactWebJson, threadsWithContact, type CalendarEventRow, type Db } from "@arcforma/store";
import type { AccountRegistry } from "./accounts.js";
import { AiError, toFailure, type AiClient, type CompleteRequest } from "./ai/client.js";
import { cleanOutput } from "./ai/features.js";
import { tokenSourceOf } from "./calendar.js";
import { log, logError } from "./log.js";
import type { ContactCard, ContactEventRef, ContactWebResult, ContactWebSummary } from "../shared/types.js";

export const WEB_LOOKUP_MIN_TWO_WAY = 3;
const PHOTO_MAX_BYTES = 512 * 1024;

const WEB_SYSTEM = [
  "You write a four-line professional summary of one person for a mail client sidebar.",
  "Use WebSearch to find public, current sources. Do not speculate and do not guess; if a line cannot be confirmed from a public source, write 'Not found' for that line.",
  "Output exactly four lines, no headings, no bullets, no markdown, no emojis, no em dashes:",
  "1. Role (their current title)",
  "2. Company (where they work, one short clause on what it does)",
  "3. Location (city and country)",
  "4. One recent public fact (a talk, a post, a launch, a press mention) with the month and year",
  "Keep every line under 20 words. Plain text only.",
].join("\n");

function toEventRef(row: CalendarEventRow): ContactEventRef {
  return { accountId: row.account_id, id: row.id, summary: row.summary ?? "(no title)", startAt: row.start_at, endAt: row.end_at, joinUrl: row.hangout_link };
}

function parseWeb(json: string | null): ContactWebSummary | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as { text?: unknown; at?: unknown };
    if (typeof v.text === "string" && typeof v.at === "number") return { text: v.text, at: v.at };
  } catch {
    // Older or foreign shape: ignore and let the user look up again.
  }
  return null;
}

export class Contacts {
  private photos = new Map<string, string | null>();
  private inflight = new Map<string, Promise<string | null>>();
  private readonly fetchImpl: (url: string) => Promise<{ ok: boolean; headers: { get(n: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }>;

  constructor(
    private readonly db: Db,
    private readonly accounts: AccountRegistry,
    private readonly ai: AiClient,
    opts: { fetch?: Contacts["fetchImpl"] } = {}
  ) {
    this.fetchImpl = opts.fetch ?? ((url) => fetch(url));
  }

  card(email: string, now = Date.now()): ContactCard {
    const e = email.trim().toLowerCase();
    const stats = contactStats(this.db, e);
    const contact = getContact(this.db, e);
    const events = eventsWithAttendee(this.db, e, now);
    const name = contactName(this.db, e) ?? e.split("@")[0] ?? e;
    return {
      email: e,
      name,
      domain: e.split("@")[1] ?? "",
      photo: this.photos.get(e) ?? null,
      twoWayThreads: stats.twoWayThreads,
      lastFromAt: stats.lastFromAt,
      lastToAt: stats.lastToAt,
      recentThreads: threadsWithContact(this.db, e, 8).map((t) => ({ accountId: t.account_id, threadId: t.id, subject: t.subject || "(no subject)", lastMessageAt: t.last_message_at, messageCount: t.message_count })),
      nextEvent: events.next ? toEventRef(events.next) : null,
      lastEvent: events.last ? toEventRef(events.last) : null,
      web: parseWeb(contact?.web_json ?? null),
      webEligible: stats.twoWayThreads >= WEB_LOOKUP_MIN_TWO_WAY,
    };
  }

  /** A data: URL for the address's photo, or null for initials. Cached per session; the URL itself is kept in contacts.photo_url. */
  photo(email: string): Promise<string | null> {
    const e = email.trim().toLowerCase();
    if (this.photos.has(e)) return Promise.resolve(this.photos.get(e) ?? null);
    const pending = this.inflight.get(e);
    if (pending) return pending;
    const task = this.resolve(e).finally(() => this.inflight.delete(e));
    this.inflight.set(e, task);
    return task;
  }

  private async resolve(e: string): Promise<string | null> {
    const known = getContact(this.db, e)?.photo_url;
    let url: string | null = null;
    if (known === "") {
      url = null;
    } else if (known) {
      url = known;
    } else {
      const signedIn = listAccounts(this.db).filter((a) => a.auth_state === "ok");
      let accessToken: ((force?: boolean) => Promise<string>) | undefined;
      for (const a of signedIn) {
        const client = this.accounts.client(a.id);
        if (client) {
          accessToken = tokenSourceOf(client);
          break;
        }
      }
      const r = await resolvePhoto(e, { accessToken });
      url = r.photoUrl;
      setContactPhoto(this.db, e, url);
      log("contacts", `${e}: photo ${r.source}`);
    }
    // A download that fails is a session miss only: the URL stays on the row so a
    // later open tries again instead of recording "no photo" for good.
    const data = url ? await this.download(url) : null;
    this.photos.set(e, data);
    return data;
  }

  /** Drops the session photo cache, for example after an account signs out. */
  forgetPhotos(): void {
    this.photos.clear();
  }

  private async download(url: string): Promise<string | null> {
    try {
      const res = await this.fetchImpl(url);
      if (!res.ok) return null;
      const type = res.headers.get("content-type") ?? "image/jpeg";
      if (!type.startsWith("image/")) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > PHOTO_MAX_BYTES) return null;
      return `data:${type.split(";")[0]};base64,${buf.toString("base64")}`;
    } catch (err) {
      logError("contacts", `photo download ${url}`, err);
      return null;
    }
  }

  async lookupWeb(email: string, now = Date.now()): Promise<ContactWebResult> {
    const e = email.trim().toLowerCase();
    const stats = contactStats(this.db, e);
    if (stats.twoWayThreads < WEB_LOOKUP_MIN_TWO_WAY) {
      return { ok: false, code: "unknown", error: `Web lookup needs at least ${WEB_LOOKUP_MIN_TWO_WAY} two-way threads with this address.` };
    }
    const name = contactName(this.db, e);
    const domain = e.split("@")[1] ?? "";
    const user = `Person: ${name ? `${name} <${e}>` : e}\nEmail domain: ${domain}\nFind this person on the public web and write the four lines.`;
    try {
      const req: CompleteRequest = { system: WEB_SYSTEM, user, allowedTools: ["WebSearch"], timeoutMs: 90_000, requestId: `contact-web:${e}` };
      const r = await this.ai.complete(req);
      const text = cleanOutput(r.text)
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 4)
        .join("\n");
      if (!text) throw new AiError("bad_response", "The lookup came back empty.");
      const web: ContactWebSummary = { text, at: now };
      setContactWebJson(this.db, e, web);
      log("contacts", `${e}: web lookup ${r.model} in ${r.latencyMs} ms`);
      return { ok: true, web };
    } catch (err) {
      return toFailure(err);
    }
  }
}
