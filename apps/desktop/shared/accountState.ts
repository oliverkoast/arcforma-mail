import type { AccountInfo } from "./types.js";

/** The mono eyebrow under an account in the sidebar, or null when there is nothing to flag. */
export function accountEyebrow(a: Pick<AccountInfo, "authState" | "syncState" | "error">): string | null {
  if (a.authState === "expired") return "SIGN IN AGAIN";
  if (a.authState === "signed_out") return "SIGNED OUT";
  if (a.syncState === "backfill" || a.syncState === "new") return "SYNCING";
  if (a.error) return "SYNC ERROR";
  return null;
}
