// Argument checks for IPC handlers. The renderer is sandboxed and ours, but an
// id it sends is still just a string: a handler that writes outbox rows or
// pokes a sync loop for an account that does not exist would leave junk
// behind, so every account id is resolved against the store first.

import { getAccount, type AccountRow, type Db } from "@arcforma/store";

export function requireAccount(db: Db, accountId: unknown): AccountRow {
  if (typeof accountId !== "string" || !accountId) throw new Error("No account given.");
  const row = getAccount(db, accountId);
  if (!row) throw new Error(`Unknown account ${accountId}.`);
  return row;
}

export function requireId(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`No ${what} given.`);
  return value;
}

/** A lowercased, trimmed address; anything that is not shaped like one is refused before it reaches SQL or the network. */
export function requireEmail(value: unknown): string {
  if (typeof value !== "string") throw new Error("No address given.");
  const e = value.trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(e)) throw new Error(`${value} is not an email address.`);
  return e;
}
