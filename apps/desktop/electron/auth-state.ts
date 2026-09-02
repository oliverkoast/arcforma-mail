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
