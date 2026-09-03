// Writing oauth-clients.json for the person, so nobody has to hand-edit a file
// in Application Support. One entry per account, appended; an existing file is
// read, kept, and rewritten whole, and the result is always mode 0600.

import fs from "node:fs";
import path from "node:path";
import { validateClientId, validateClientSecret, validateEmail } from "../../shared/onboarding.js";

export interface ClientEntry {
  id: string;
  email: string;
  clientId: string;
  clientSecret: string;
  consent: "internal" | "external";
}

export interface ClientsFile {
  accounts: ClientEntry[];
}

const MODE = 0o600;

/** Reads the file, tolerating a missing one. A file that is not JSON is an error: overwriting it would lose credentials. */
export function readClientsFile(file: string): ClientsFile {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { accounts: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message}). Fix or move that file before adding an account here.`);
  }
  const accounts = (parsed as { accounts?: unknown })?.accounts;
  if (!Array.isArray(accounts)) return { accounts: [] };
  const out: ClientEntry[] = [];
  for (const raw2 of accounts) {
    const a = raw2 as Partial<ClientEntry>;
    if (typeof a.id !== "string" || !a.id) continue;
    out.push({
      id: a.id,
      email: typeof a.email === "string" ? a.email : "",
      clientId: typeof a.clientId === "string" ? a.clientId : "",
      clientSecret: typeof a.clientSecret === "string" ? a.clientSecret : "",
      consent: a.consent === "external" ? "external" : "internal",
    });
  }
  return { accounts: out };
}

/** Writes the whole file at mode 0600 through a temp file in the same folder, so a crash never leaves half a file. */
export function writeClientsFile(file: string, data: ClientsFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: MODE });
  fs.chmodSync(tmp, MODE);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, MODE);
}

export interface AddAccountInput {
  id: string;
  email: string;
  clientId: string;
  clientSecret: string;
  consent: "internal" | "external";
}

/**
 * Adds one account to the clients file. Every existing entry is kept as it was.
 * A slot id or an address that is already there is refused rather than merged,
 * because a silent overwrite would swap the credentials of a working mailbox.
 */
export function addAccount(file: string, input: AddAccountInput): ClientEntry {
  const email = validateEmail(input.email);
  if (!email.ok) throw new Error(email.message);
  const clientId = validateClientId(input.clientId);
  if (!clientId.ok) throw new Error(clientId.message);
  const clientSecret = validateClientSecret(input.clientSecret);
  if (!clientSecret.ok) throw new Error(clientSecret.message);
  const id = String(input.id ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) throw new Error("An account slot id is lowercase letters, digits, and dashes.");

  const current = readClientsFile(file);
  if (current.accounts.some((a) => a.id === id)) throw new Error(`${file} already has an account called ${id}. Pick another address or remove that entry first.`);
  if (current.accounts.some((a) => a.email.toLowerCase() === email.value)) throw new Error(`${email.value} is already in ${file}. Sign in to it instead of adding it again.`);
  if (current.accounts.some((a) => a.clientId === clientId.value)) throw new Error("That client id is already used by another account here. Each account needs its own OAuth client.");

  const entry: ClientEntry = { id, email: email.value, clientId: clientId.value, clientSecret: clientSecret.value, consent: input.consent === "external" ? "external" : "internal" };
  writeClientsFile(file, { accounts: [...current.accounts, entry] });
  return entry;
}

/** The slot ids already in the file, so a new account can be given one that is free. */
export function takenIds(file: string): string[] {
  return readClientsFile(file).accounts.map((a) => a.id);
}
