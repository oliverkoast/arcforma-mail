// Account state transitions that touch the store only, kept apart from the
// registry (which needs Electron for the Keychain and the browser) so they can
// be tested under node:test. The registry calls these and then emits.

import { clearCalendarForAccount, updateAccount, type Db } from "@arcforma/store";

export const REAUTH_MESSAGE = "Sign in again to keep this account connected.";

/** invalid_grant: the refresh token is dead. The account waits for a fresh sign-in; local mail stays. */
export function markAccountExpired(db: Db, accountId: string): void {
  updateAccount(db, accountId, { auth_state: "expired", sync_state: "reauth", error: REAUTH_MESSAGE });
}

/**
 * Sign-out: the account is marked signed out and everything that only made
 * sense while the app could read its Google data goes with it. Mail stays
 * (the user was told so), the calendar does not: the rail would otherwise keep
 * showing busy blocks and meetings the app can no longer refresh, and a later
 * sign-in would resume from a stale sync token.
 */
export function clearAccountOnSignOut(db: Db, accountId: string): { calendarEvents: number } {
  const { events } = clearCalendarForAccount(db, accountId);
  updateAccount(db, accountId, { auth_state: "signed_out", error: null });
  return { calendarEvents: events };
}

/** Shown while the Keychain refuses the app. It is a condition of the machine, and it passes. */
export const KEYCHAIN_MESSAGE = "Keychain access is off, so the saved sign-in cannot be read. Quit and reopen Arcforma Mail; if macOS asks, choose Always Allow.";

/**
 * What to record when the Keychain cannot be read: the error, and nothing else.
 *
 * This used to set auth_state to signed_out. The token was still on disk, encrypted and valid; only
 * the ability to decrypt it had gone, and it comes back the moment the app is reopened or the
 * Keychain prompt is allowed. Marking the account signed out turned a passing condition into a
 * permanent one: the sync loop only schedules accounts that are ok, so nothing ever tried again,
 * the sidebar said SIGNED OUT, and the only way back was a full sign-in, which itself needs the
 * Keychain and so failed too. That is exactly the night of 2026-09-08. The account stays ok, the
 * error says what to do, and the sync loop keeps retrying until the Keychain answers.
 */
export function keychainUnavailablePatch(): { error: string } {
  return { error: KEYCHAIN_MESSAGE };
}

/**
 * Whether an account marked signed out was in fact only refused by the Keychain.
 *
 * A real sign-out deletes the token from disk (clearAccountOnSignOut), so an account that says
 * signed_out while its encrypted token is still there, and whose error names the Keychain, was
 * demoted by the old code path on a Keychain refusal. Restoring it to ok puts it back in the sync
 * loop, which now retries until the Keychain answers. The error is kept so the sidebar explains
 * itself until the first good poll clears it.
 */
export function shouldRestoreAfterKeychain(row: { auth_state: string; error: string | null }, hasToken: boolean): boolean {
  return row.auth_state === "signed_out" && hasToken && /keychain/i.test(row.error ?? "");
}
