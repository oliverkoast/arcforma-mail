// Who to offer when someone starts typing a recipient.
//
// The ranking is the whole feature. Any mailbox holds thousands of addresses, most of them
// noreply@ and people cc'd once two years ago, so an alphabetical or purely recent list is worse
// than nothing. What is being asked is "who do I write to", and the honest answer to that is in the
// outbound mail: an address that has been sent to is worth far more than one that merely appeared
// in an inbox, which is why sent-to count leads and everything else breaks its ties.
//
// The contacts table is not the source. It is filled lazily when a contact panel opens, so it knows
// about a handful of people, while the messages hold every address that has ever been used.

import type { Db } from "../db.js";

export interface RecipientSuggestion {
  email: string;
  name: string;
  /** How many messages have gone to this address. The strongest signal, and shown as nothing. */
  sent: number;
  /** How many have come from it. */
  received: number;
  lastAt: number;
}

/**
 * Everything typing "equ" should reach: a name, an address, or the company's domain.
 *
 * Every match is the start of a word, in the address as well as the name. A plain substring on the
 * address was the obvious way to make "equinox" find zach.elin@equinox.com, and it also made "art"
 * find dana.hart@, which is the kind of result that makes people stop reading the list. An address
 * is split on its punctuation so that "zach", "elin", "equinox" and "com" all match it and "art"
 * does not.
 */
function matches(needle: string, email: string, name: string): boolean {
  if (!needle) return true;
  const e = email.toLowerCase();
  if (e.startsWith(needle)) return true;
  if (e.split(/[.@+_-]+/).some((part) => part.startsWith(needle))) return true;
  return name.toLowerCase().split(/[\s,.]+/).some((word) => word.startsWith(needle));
}

/**
 * Addresses worth suggesting for `query`, best first.
 *
 * Cheap enough to run on every keystroke: one scan of the message table's address columns, which is
 * a few hundred rows in a real mailbox, and no join.
 */
export function suggestRecipients(db: Db, query: string, opts: { limit?: number; exclude?: string[] } = {}): RecipientSuggestion[] {
  const needle = query.trim().toLowerCase();
  const exclude = new Set((opts.exclude ?? []).map((e) => e.toLowerCase()));
  const rows = db
    .prepare(
      `SELECT lower(json_extract(je.value, '$.email')) AS email,
              json_extract(je.value, '$.name') AS name,
              CASE WHEN m.direction = 'out' THEN 1 ELSE 0 END AS sent,
              m.internal_date AS at
         FROM messages m, json_each(m.to_json) je
        WHERE json_extract(je.value, '$.email') IS NOT NULL
        UNION ALL
       SELECT lower(json_extract(je.value, '$.email')),
              json_extract(je.value, '$.name'),
              CASE WHEN m.direction = 'out' THEN 1 ELSE 0 END,
              m.internal_date
         FROM messages m, json_each(m.cc_json) je
        WHERE json_extract(je.value, '$.email') IS NOT NULL
        UNION ALL
       SELECT lower(m.from_email), m.from_name, 0, m.internal_date
         FROM messages m
        WHERE m.from_email IS NOT NULL AND m.from_email != '' AND m.direction = 'in'`,
    )
    .all() as Array<{ email: string | null; name: string | null; sent: number; at: number }>;

  const byEmail = new Map<string, RecipientSuggestion>();
  for (const row of rows) {
    const email = (row.email ?? "").trim();
    if (!email || exclude.has(email)) continue;
    const name = (row.name ?? "").trim();
    let hit = byEmail.get(email);
    if (!hit) {
      hit = { email, name, sent: 0, received: 0, lastAt: 0 };
      byEmail.set(email, hit);
    }
    // A real name beats an empty one, and a longer one beats a bare local part.
    if (name.length > hit.name.length) hit.name = name;
    if (row.sent) hit.sent += 1;
    else hit.received += 1;
    if (row.at > hit.lastAt) hit.lastAt = row.at;
  }

  return [...byEmail.values()]
    .filter((c) => matches(needle, c.email, c.name))
    .sort((a, b) => b.sent - a.sent || b.received - a.received || b.lastAt - a.lastAt || a.email.localeCompare(b.email))
    .slice(0, opts.limit ?? 6);
}
