import path from "node:path";
import { app } from "electron";
import { defaultOAuthClientsPath } from "@arcforma/gmail";

export function userDataDir(): string {
  return app.getPath("userData");
}

export function dbPath(): string {
  return path.join(userDataDir(), "mail.db");
}

export function tokensPath(): string {
  return path.join(userDataDir(), "tokens.json");
}

export function oauthClientsPath(): string {
  return process.env["ARCMAIL_OAUTH_CLIENTS"] || defaultOAuthClientsPath();
}
