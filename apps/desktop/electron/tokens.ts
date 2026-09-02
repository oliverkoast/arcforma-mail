// Refresh tokens are the only secret the app keeps. They are encrypted with
// Electron safeStorage (macOS Keychain-backed) and written to tokens.json in
// the app's user data folder. Access tokens live in memory only.

import fs from "node:fs";
import { safeStorage } from "electron";
import { tokensPath } from "./paths.js";

type TokenFile = Record<string, string>;

function readFile(): TokenFile {
  const file = tokensPath();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as TokenFile;
  } catch {
    return {};
  }
}

function writeFile(data: TokenFile): void {
  const file = tokensPath();
  // mode only applies when the file is created; keep an existing file owner-only too.
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort; the blobs inside are Keychain-encrypted either way.
  }
}

function requireEncryption(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Keychain encryption is unavailable, so the refresh token was not stored.");
  }
}

export function saveRefreshToken(accountId: string, refreshToken: string): void {
  requireEncryption();
  const data = readFile();
  data[accountId] = safeStorage.encryptString(refreshToken).toString("base64");
  writeFile(data);
}

export function loadRefreshToken(accountId: string): string | null {
  const data = readFile();
  const blob = data[accountId];
  if (!blob) return null;
  requireEncryption();
  try {
    return safeStorage.decryptString(Buffer.from(blob, "base64"));
  } catch {
    return null;
  }
}

export function deleteRefreshToken(accountId: string): void {
  const data = readFile();
  delete data[accountId];
  writeFile(data);
}

export function hasRefreshToken(accountId: string): boolean {
  return Boolean(readFile()[accountId]);
}
