import { useApp } from "../state/store";
import type { AccountInfo } from "../../shared/types";

function stateLine(a: AccountInfo): string {
  if (a.authState === "ok") return a.syncState === "live" ? "Signed in and syncing." : "Signed in. First sync runs after all sign-ins.";
  if (a.authState === "expired") return "The weekly token expired. Sign in again.";
  return a.consent === "external" ? "External consent: Google expires this token every 7 days." : "Internal consent: no expiry.";
}

export function Onboarding() {
  const status = useApp((s) => s.status);
  const signIn = useApp((s) => s.signIn);
  const error = useApp((s) => s.error);

  return (
    <section className="onboarding" aria-label="Sign in">
      <div className="onboarding-card">
        <span className="af-mono">Accounts</span>
        <h1 className="af-h2">Connect your inboxes.</h1>
        <p className="af-body">
          Three accounts, one inbox. Sign in once per account. The refresh token is kept in your Keychain and the last 90 days sync in the background.
        </p>
        {status.configError ? (
          <div className="notice">
            <span className="af-mono">Setup</span>
            <span>{status.configError}</span>
            <span className="af-mono">{status.configPath}</span>
          </div>
        ) : null}
        <div className="account-list">
          {status.accounts.map((a) => (
            <div className="account-row" key={a.id}>
              <div>
                <span className="af-mono">{a.consent === "external" ? "External · testing" : "Internal"}</span>
                <div className="account-email">{a.email}</div>
                <div className="account-state">{a.error ?? stateLine(a)}</div>
              </div>
              {a.authState === "ok" ? (
                <span className="af-mono">Signed in</span>
              ) : (
                <button className="btn btn-sweep btn-compact" onClick={() => void signIn(a.id)} disabled={!a.configured}>
                  {!a.configured ? "Add client id first" : a.authState === "expired" ? "Sign in again" : "Sign in"}
                </button>
              )}
            </div>
          ))}
        </div>
        {error ? (
          <div className="notice">
            <span className="af-mono">Sign-in failed</span>
            <span>{error}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
