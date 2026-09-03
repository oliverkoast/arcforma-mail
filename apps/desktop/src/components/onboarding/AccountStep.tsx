import { useState } from "react";
import { invoke } from "../../bridge";
import { useApp } from "../../state/store";
import { consoleUrl, validateClientId, validateClientSecret, validateEmail, validateProjectId, type ConsoleLink } from "../../../shared/onboarding";
import { Field, StepCard } from "./parts";
import type { AccountInfo } from "../../../shared/types";

const LINKS: Array<{ id: ConsoleLink; label: string; tip: string }> = [
  { id: "createProject", label: "1. Open the new project page", tip: "Opens console.cloud.google.com in your browser at the project creation form." },
  { id: "enableApis", label: "2. Turn on Gmail, Calendar, and People", tip: "Opens the bulk enable page with all three APIs already filled in for this project." },
  { id: "consentScreen", label: "3. Open the consent screen", tip: "Opens the Google Auth Platform branding page, where you set the app name and the audience." },
  { id: "credentials", label: "4. Create a Desktop OAuth client", tip: "Opens the OAuth clients page. Create credentials, then OAuth client ID, then Desktop app." },
];

function accountLine(a: AccountInfo): string {
  if (a.authState === "ok") return "Signed in. Mail is arriving.";
  if (a.authState === "expired") return "The token expired. One sign-in restores it.";
  if (!a.configured) return "Saved without credentials. Add a client id and secret.";
  return "Saved. Not signed in yet.";
}

/**
 * One account at a time: the address, which kind of Google account it is, the
 * four console pages in order, then the client id and secret by paste. Saving
 * writes oauth-clients.json in the main process and runs the browser sign-in
 * straight away, so the first mail lands while the flow is still open.
 */
export function AccountStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const accounts = useApp((s) => s.status.accounts);
  const clientsPath = useApp((s) => s.onboarding?.clientsPath ?? s.status.configPath);
  const addAccount = useApp((s) => s.addOnboardingAccount);
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState<"internal" | "external">("internal");
  const [projectId, setProjectId] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const openLink = (link: ConsoleLink) => {
    const project = validateProjectId(projectId);
    if (!project.ok) {
      setErrors((e) => ({ ...e, projectId: project.message }));
      return;
    }
    setErrors((e) => ({ ...e, projectId: "" }));
    void invoke("onboarding:openConsole", link, project.value).catch((err) => setErrors((e) => ({ ...e, form: (err as Error).message })));
  };

  const save = async () => {
    const checks = { email: validateEmail(email), clientId: validateClientId(clientId), clientSecret: validateClientSecret(clientSecret) };
    const next: Record<string, string> = {};
    for (const [key, r] of Object.entries(checks)) if (!r.ok) next[key] = r.message;
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setSaved(null);
    const result = await addAccount({ email: email.trim().toLowerCase(), consent, clientId: clientId.trim(), clientSecret: clientSecret.trim() });
    setBusy(false);
    if (result.ok) {
      setSaved(email.trim().toLowerCase());
      setEmail("");
      setClientId("");
      setClientSecret("");
      setProjectId("");
    } else {
      setErrors({ form: result.error });
    }
  };

  return (
    <StepCard
      eyebrow={`Step 2 of 6 · ${accounts.length} account${accounts.length === 1 ? "" : "s"} added`}
      title="Add a Gmail account."
      actions={
        <>
          <button className="btn btn-sweep" disabled={busy} data-tip="Writes the client id and secret to the clients file, then opens Google in your browser to authorize this account." onClick={() => void save()}>
            {busy ? "Waiting for the browser sign-in" : "Save and sign in"}
          </button>
          <button className="btn btn-nav btn-compact" data-tip="Goes on to the AI step. Come back to Settings to add more accounts later." onClick={onNext}>
            {accounts.length ? "Done adding accounts" : "Skip for now"}
          </button>
          <button className="btn btn-ghost btn-compact" data-tip="Back to what the app is." onClick={onBack}>
            Back
          </button>
        </>
      }
    >
      <p className="af-body">
        Gmail's scopes are restricted, so every account signs in through an OAuth client you own. A Workspace account can use an Internal consent screen, which needs no Google review and hands out tokens that never expire. A personal
        gmail.com account can only be External, and Google expires an External app's token every seven days, so that one needs a sign-in each week until the app is verified.
      </p>
      {accounts.length ? (
        <div className="setup-accounts">
          {accounts.map((a) => (
            <div className="setup-account" key={a.id}>
              <span className={`af-mono${a.authState === "ok" ? "" : " eyebrow-flag"}`}>{a.consent === "external" ? "External · 7 day token" : "Internal · no expiry"}</span>
              <span className="setup-fact-name">{a.email}</span>
              <span className="setup-fact-detail">{a.error ?? accountLine(a)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {saved ? (
        <p className="setup-note">
          <span className="af-mono">Saved</span> {saved} is in {clientsPath}, readable only by you. Add another below, or go on.
        </p>
      ) : null}

      <Field label="Address" value={email} onChange={setEmail} placeholder="you@example.com" error={errors["email"]} tip="The mailbox this OAuth client is for. It has to match the account you sign in as." />

      <div className="setup-radios">
        <button className={`setup-radio${consent === "internal" ? " is-on" : ""}`} aria-pressed={consent === "internal"} data-tip="A Google Workspace account inside an organization you administer. Internal consent, tokens with no expiry." onClick={() => setConsent("internal")}>
          <span className="setup-choice-name">Google Workspace</span>
          <span className="setup-choice-line">Internal consent screen. No Google review, and the token never expires.</span>
          {consent === "internal" ? <span className="af-mono setup-choice-mark">Chosen</span> : null}
        </button>
        <button className={`setup-radio${consent === "external" ? " is-on" : ""}`} aria-pressed={consent === "external"} data-tip="A personal gmail.com account. External consent left in Testing, so Google expires the token every seven days." onClick={() => setConsent("external")}>
          <span className="setup-choice-name">Personal Gmail</span>
          <span className="setup-choice-line">External consent, left in Testing. Google expires the token every 7 days.</span>
          {consent === "external" ? <span className="af-mono setup-choice-mark">Chosen</span> : null}
        </button>
      </div>

      <Field
        label="Project id, optional"
        value={projectId}
        onChange={setProjectId}
        placeholder="arcforma-mail"
        error={errors["projectId"]}
        hint="Fill this in after step 1 and the next three buttons open straight into that project."
        tip="The project id under the project name in the console. With it, the console links skip the project picker."
      />

      <div className="setup-links">
        {LINKS.map((l) => (
          <button className="btn btn-nav btn-compact" key={l.id} data-tip={l.tip} onClick={() => openLink(l.id)}>
            {l.label}
          </button>
        ))}
      </div>
      <p className="setup-note">
        On step 3 set the app name to Arcforma Mail, choose {consent === "internal" ? "Internal" : "External and leave it in Testing, adding this address under Test users"}, and paste the six scopes listed in
        docs/google-cloud-setup.md. On step 4 the application type is Desktop app. Then copy both fields it shows you into the two boxes below.
      </p>

      <Field
        label="Client id"
        value={clientId}
        onChange={setClientId}
        placeholder="000000000000-xxxxxxxx.apps.googleusercontent.com"
        error={errors["clientId"]}
        tip="The Client ID field from the OAuth client you just created. It ends in .apps.googleusercontent.com."
      />
      <Field
        label="Client secret"
        value={clientSecret}
        onChange={setClientSecret}
        type="password"
        placeholder="Paste the client secret"
        error={errors["clientSecret"]}
        hint="Written to the clients file with permissions that only let you read it, and never shown here again."
        tip="The Client secret field next to the client id. It is written to disk at mode 600 and is not read back into this window."
      />
      {busy ? <p className="setup-note">Google is open in your browser. This waits three minutes, then gives up and leaves the credentials saved so you can sign in from Settings.</p> : null}
      {errors["form"] ? <p className="setup-error">{errors["form"]}</p> : null}
    </StepCard>
  );
}
