/**
 * Whether first-run setup has anything left to ask.
 *
 * The stored flag is the person's own answer, and it is cleared on purpose when they reopen setup
 * from Settings. But a cleared flag must not put the wizard over a working app on every launch: on
 * 2026-09-09 both accounts were signed in and syncing while the accounts step sat on top saying
 * otherwise. A signed-in account means setup did its job, whatever the flag says.
 */
export function setupIsDone(storedDone: unknown, accounts: ReadonlyArray<{ auth_state: string }>): boolean {
  if (storedDone === true) return true;
  return accounts.some((a) => a.auth_state === "ok");
}
