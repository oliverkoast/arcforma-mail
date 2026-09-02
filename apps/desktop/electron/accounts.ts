// Account registry: the three known accounts, their OAuth client configs from
// oauth-clients.json, stored refresh tokens, and one GmailClient per account.

import { shell } from "electron";
import { GmailClient, createTokenSource, getOwners, loadOAuthClients, runLoopbackFlow, type OAuthClientConfig, loadAccountIdentities } from "@arcforma/gmail";
import { getAccount, listAccounts, updateAccount, upsertAccount, type AccountRow, type Db } from "@arcforma/store";
import { clearAccountOnSignOut, markAccountExpired } from "./auth-state.js";
import { emit } from "./events.js";
import { log, logError } from "./log.js";
import { oauthClientsPath } from "./paths.js";
import { deleteRefreshToken, hasRefreshToken, loadRefreshToken, saveRefreshToken } from "./tokens.js";
import type { AccountInfo, AccountsStatus } from "../shared/types.js";

/** The accounts Arcforma Mail is built for. oauth-clients.json supplies the client ids. */
// Accounts are whatever oauth-clients.json names. Nothing about whose mailbox this is belongs in
// the source: see docs/google-cloud-setup.md for the file, and README for why each account needs
// its own OAuth client.

export class AccountRegistry {
  private configs = new Map<string, OAuthClientConfig>();
  private clients = new Map<string, GmailClient>();
  configError: string | null = null;
  onAuthExpired: ((accountId: string) => void) | null = null;
  onSignedOut: ((accountId: string) => void) | null = null;

  constructor(private readonly db: Db) {}

  reloadConfig(): void {
    try {
      const list = loadOAuthClients(oauthClientsPath());
      this.configs = new Map(list.map((c) => [c.id, c]));
      this.configError = list.length === 0
        ? "The clients file is in place but every clientId is blank. Paste the ids from the Google Cloud console; the click path is in docs/google-cloud-setup.md."
        : null;
    } catch (err) {
      this.configs = new Map();
      this.configError = (err as Error).message;
    }
    for (const k of loadAccountIdentities(oauthClientsPath())) upsertAccount(this.db, { id: k.id, email: k.email, consent: k.consent });
    for (const c of this.configs.values()) upsertAccount(this.db, { id: c.id, email: c.email, consent: c.consent });
    // A token that no longer decrypts or a config that vanished means signed out.
    for (const row of listAccounts(this.db)) {
      if (row.auth_state === "ok" && !hasRefreshToken(row.id)) updateAccount(this.db, row.id, { auth_state: "signed_out" });
    }
  }

  status(): AccountsStatus {
    return { accounts: this.list(), configPath: oauthClientsPath(), configError: this.configError };
  }

  list(): AccountInfo[] {
    return listAccounts(this.db).map((row) => this.toInfo(row));
  }

  private toInfo(row: AccountRow): AccountInfo {
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      consent: row.consent,
      authState: row.auth_state,
      syncState: row.sync_state,
      configured: this.configs.has(row.id),
      backfill: row.sync_state === "backfill" || row.sync_state === "new" ? { done: row.backfill_done, total: row.backfill_total } : null,
      lastSyncAt: row.last_sync_at,
      error: row.error,
    };
  }

  ownerAddresses(accountId: string): string[] {
    const row = getAccount(this.db, accountId);
    if (!row) return [];
    const out = new Set<string>([row.email]);
    try {
      for (const a of JSON.parse(row.send_as_json ?? "[]") as Array<{ email: string; verified: boolean }>) if (a.verified) out.add(a.email);
    } catch {
      // Older rows without send_as_json fall back to the primary address.
    }
    return Array.from(out);
  }

  /** A client for a signed-in account, or null when there is no usable token. */
  client(accountId: string): GmailClient | null {
    const cached = this.clients.get(accountId);
    if (cached) return cached;
    const config = this.configs.get(accountId);
    const refreshToken = loadRefreshToken(accountId);
    if (!config || !refreshToken) return null;
    const client = new GmailClient({
      accessToken: createTokenSource({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        refreshToken,
        onInvalidGrant: () => this.expire(accountId),
      }),
      onRetry: (info) => log("gmail", `${accountId} retry ${info.status} in ${info.waitMs} ms`),
    });
    this.clients.set(accountId, client);
    return client;
  }

  private expire(accountId: string): void {
    this.clients.delete(accountId);
    markAccountExpired(this.db, accountId);
    emit("accounts:changed", this.status());
    this.onAuthExpired?.(accountId);
  }

  async signIn(accountId: string): Promise<AccountsStatus> {
    const config = this.configs.get(accountId);
    if (!config) {
      throw new Error(this.configError ?? `No OAuth client for ${accountId} in ${oauthClientsPath()}.`);
    }
    log("auth", `sign-in ${accountId} (${config.email})`);
    const result = await runLoopbackFlow({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      loginHint: config.email,
      openUrl: (url) => shell.openExternal(url),
    });
    if (result.email && result.email !== config.email) {
      throw new Error(`You signed in as ${result.email}. This slot is for ${config.email}.`);
    }
    saveRefreshToken(accountId, result.refreshToken);
    this.clients.delete(accountId);
    const row = getAccount(this.db, accountId);
    updateAccount(this.db, accountId, {
      auth_state: "ok",
      sync_state: row?.history_id ? "live" : "new",
      error: null,
    });
    const client = this.client(accountId);
    if (client) {
      try {
        const owners = await getOwners(client);
        updateAccount(this.db, accountId, {
          signature_html: owners.signatureHtml,
          send_as_json: JSON.stringify(owners.sendAs),
          display_name: owners.sendAs.find((s) => s.isPrimary)?.name || null,
        });
      } catch (err) {
        logError("auth", `owners lookup failed for ${accountId}`, err);
      }
    }
    const status = this.status();
    emit("accounts:changed", status);
    return status;
  }

  signOut(accountId: string): AccountsStatus {
    deleteRefreshToken(accountId);
    this.clients.delete(accountId);
    const cleared = clearAccountOnSignOut(this.db, accountId);
    log("auth", `sign-out ${accountId}: token removed, ${cleared.calendarEvents} calendar events dropped`);
    this.onSignedOut?.(accountId);
    const status = this.status();
    emit("accounts:changed", status);
    return status;
  }
}
