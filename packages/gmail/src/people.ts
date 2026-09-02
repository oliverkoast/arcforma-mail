// Contact photo lookup: Google People API on the account's own token (needs
// the contacts.readonly scope; a 403 just means "not granted"), then Gravatar
// by the md5 of the lowercased address, then nothing, which the UI renders as
// initials. Every hop goes through the injectable Transport so the chain is
// testable without a network.

import { createHash } from "node:crypto";
import { fetchTransport, type Transport } from "./transport.js";

export const PEOPLE_API = "https://people.googleapis.com/v1";
export const GRAVATAR_BASE = "https://www.gravatar.com/avatar";

export interface PersonMatch {
  name: string | null;
  photoUrl: string | null;
}

interface PeopleSearchResponse {
  results?: Array<{ person?: { names?: Array<{ displayName?: string }>; photos?: Array<{ url?: string; default?: boolean }> } }>;
}

function pickPerson(res: PeopleSearchResponse): PersonMatch | null {
  for (const r of res.results ?? []) {
    const p = r.person;
    if (!p) continue;
    const photo = (p.photos ?? []).find((ph) => ph.url && ph.default !== true)?.url ?? null;
    const name = p.names?.[0]?.displayName ?? null;
    if (photo || name) return { name, photoUrl: photo };
  }
  return null;
}

export interface PeopleLookupOptions {
  accessToken: (force?: boolean) => Promise<string>;
  transport?: Transport;
  signal?: AbortSignal;
}

/**
 * Looks the address up in the account's contacts, then in "other contacts"
 * (people they have emailed). Null on no match or on a scope the token does
 * not carry; only transport failures throw.
 */
export async function lookupPerson(email: string, opts: PeopleLookupOptions): Promise<PersonMatch | null> {
  const transport = opts.transport ?? fetchTransport;
  const query = encodeURIComponent(email.trim().toLowerCase());
  const endpoints = [`${PEOPLE_API}/people:searchContacts?query=${query}&readMask=names,photos&pageSize=3`, `${PEOPLE_API}/otherContacts:search?query=${query}&readMask=names,photos&pageSize=3`];
  let nameOnly: PersonMatch | null = null;
  for (const url of endpoints) {
    const token = await opts.accessToken(false);
    const res = await transport(url, { method: "GET", headers: { Authorization: `Bearer ${token}` }, signal: opts.signal });
    const text = await res.text();
    if (res.status !== 200) {
      // 401/403: no scope or no consent; 404: API not enabled. None of these are errors the rail should show.
      if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 400) continue;
      throw new Error(`People API ${res.status}`);
    }
    let parsed: PeopleSearchResponse;
    try {
      parsed = JSON.parse(text) as PeopleSearchResponse;
    } catch {
      continue;
    }
    const match = pickPerson(parsed);
    if (match?.photoUrl) return match;
    // A name without a photo is worth keeping, but the next endpoint may still have the picture.
    if (match && !nameOnly) nameOnly = match;
  }
  return nameOnly;
}

export function gravatarHash(email: string): string {
  return createHash("md5").update(email.trim().toLowerCase()).digest("hex");
}

export function gravatarUrl(email: string, size = 160): string {
  return `${GRAVATAR_BASE}/${gravatarHash(email)}?d=404&s=${size}`;
}

/** The Gravatar URL when one is registered for the address, else null. */
export async function lookupGravatar(email: string, transport: Transport = fetchTransport, signal?: AbortSignal): Promise<string | null> {
  const url = gravatarUrl(email);
  const res = await transport(url, { method: "HEAD", signal });
  return res.status === 200 ? url : null;
}

export interface PhotoResolution {
  source: "people" | "gravatar" | "none";
  photoUrl: string | null;
  name: string | null;
}

/**
 * People API first, Gravatar second, initials last. A failing hop is skipped,
 * not surfaced: a photo is a nicety, never a reason to show an error.
 */
export async function resolvePhoto(email: string, opts: { accessToken?: PeopleLookupOptions["accessToken"]; transport?: Transport; signal?: AbortSignal }): Promise<PhotoResolution> {
  const transport = opts.transport ?? fetchTransport;
  let name: string | null = null;
  if (opts.accessToken) {
    try {
      const person = await lookupPerson(email, { accessToken: opts.accessToken, transport, signal: opts.signal });
      if (person) {
        name = person.name;
        if (person.photoUrl) return { source: "people", photoUrl: person.photoUrl, name };
      }
    } catch {
      // Network trouble on the People hop; try the next one.
    }
  }
  try {
    const url = await lookupGravatar(email, transport, opts.signal);
    if (url) return { source: "gravatar", photoUrl: url, name };
  } catch {
    // Same: fall through to initials.
  }
  return { source: "none", photoUrl: null, name };
}
