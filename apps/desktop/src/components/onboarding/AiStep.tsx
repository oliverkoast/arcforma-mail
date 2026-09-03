import { useEffect, useState } from "react";
import { invoke } from "../../bridge";
import { aiAvailability, validateApiKey, validateClaudeToken, type AiChoice } from "../../../shared/onboarding";
import { Choice, StepCard } from "./parts";
import type { OnboardingAiInfo } from "../../../shared/types";

/**
 * Three ways AI works here, with what each one costs you written out. The
 * daemon is asked what is already on the Mac first, so somebody who signed in
 * to Claude Code months ago is told so rather than asked to paste a token.
 */
export function AiStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [info, setInfo] = useState<OnboardingAiInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [choice, setChoice] = useState<AiChoice | null>(null);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoading(true);
    void invoke("onboarding:aiState")
      .then((next) => {
        setInfo(next);
        setLoading(false);
      })
      .catch((err) => {
        setError((err as Error).message);
        setLoading(false);
      });
  };
  useEffect(load, []);

  const availability = aiAvailability(info?.status ?? null, info?.storedChoice ?? null);
  const active = choice ?? availability.choice;

  const pick = (next: AiChoice) => {
    setChoice(next);
    setSecret("");
    setError(null);
    setSaved(null);
  };

  const save = async () => {
    if (active === "claude-code" && !availability.claudeReady) {
      const token = validateClaudeToken(secret);
      if (!token.ok) return setError(token.message);
    }
    if (active === "api-key") {
      const key = validateApiKey(secret);
      if (!key.ok) return setError(key.message);
    }
    setBusy(true);
    setError(null);
    try {
      const next = await invoke("onboarding:setAi", active, secret.trim() || undefined);
      setInfo(next);
      setSecret("");
      setSaved(active === "local" ? "Local only. Nothing is stored and nothing leaves the Mac." : "Stored in the daemon config, readable only by you. The daemon uses it after its next restart.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Claude Code that already answers needs nothing pasted, so there is nothing to save.
  const nothingToSave = active === "claude-code" && availability.claudeReady;

  return (
    <StepCard
      eyebrow="Step 3 of 6"
      title="Choose how AI works."
      actions={
        <>
          {nothingToSave ? null : (
            <button className="btn btn-sweep" disabled={busy || loading} data-tip="Writes this choice to the AI daemon config on this Mac." onClick={() => void save()}>
              {busy ? "Saving" : active === "local" ? "Use local only" : "Save and continue"}
            </button>
          )}
          <button className="btn btn-nav btn-compact" data-tip="Goes on to the local model step. Nothing is saved by this button." onClick={onNext}>
            {nothingToSave || saved ? "Next" : "Skip for now"}
          </button>
          <button className="btn btn-ghost btn-compact" data-tip="Back to adding accounts." onClick={onBack}>
            Back
          </button>
        </>
      }
    >
      <p className="af-body">
        Background sorting always runs on the local model and never leaves this Mac. This choice is only about the on-demand work: thread summaries, instant replies, auto-draft, and Ask. Skipping lands on local only, which you can change
        in Settings later.
      </p>
      <p className="setup-note">
        <span className="af-mono">{loading ? "Checking" : availability.daemonRunning ? "Daemon up" : "Daemon down"}</span> {loading ? "Asking the AI daemon what is on this Mac." : availability.detail}
      </p>

      <Choice
        on={active === "local"}
        name="Local only"
        line="Background sorting works. No summaries, no drafts, no Ask. Nothing at all leaves the machine."
        tip="Picks local only. The four Claude features show a sign-in eyebrow instead of running."
        onPick={() => pick("local")}
      >
        <p className="setup-note">The four Claude features stay visible and say they need a sign-in. Everything else in the app is unaffected.</p>
      </Choice>

      <Choice
        on={active === "claude-code"}
        name="Claude Code login"
        line="Uses a Claude subscription you already pay for. No API bill. The text you ask about goes to Anthropic."
        tip="Picks the Claude Code login. A long-lived token from claude setup-token is stored for the daemon."
        onPick={() => pick("claude-code")}
      >
        {availability.claudeReady ? (
          <p className="setup-note">Nothing to paste. The daemon already reaches Claude through this Mac's login, so summaries, drafts, and Ask work as soon as you finish setup.</p>
        ) : (
          <>
            <p className="setup-note">
              In a terminal run <span className="af-mono">claude setup-token</span> and copy the line it prints. That token is long-lived, unlike the one <span className="af-mono">claude auth login</span> leaves behind, which expires in
              hours and the daemon cannot refresh.
            </p>
            <label className="setup-field">
              <span className="af-mono">Token</span>
              <input type="password" value={secret} spellCheck={false} autoComplete="off" placeholder="Paste the token from claude setup-token" data-tip="Stored in the AI daemon config at mode 600 and never read back into this window." onChange={(e) => setSecret(e.target.value)} />
            </label>
          </>
        )}
      </Choice>

      <Choice
        on={active === "api-key"}
        name="Anthropic API key"
        line="Billed per request to your Anthropic account. Works without a Claude subscription. The text you ask about goes to Anthropic."
        tip="Picks an Anthropic API key. It is stored in the AI daemon config and passed to the model runner."
        onPick={() => pick("api-key")}
      >
        <p className="setup-note">Create a key at console.anthropic.com. It is stored in the daemon config on this Mac and used for the same four features. Nothing verifies it until the first summary, which reports the failure plainly.</p>
        <label className="setup-field">
          <span className="af-mono">Key</span>
          <input type="password" value={secret} spellCheck={false} autoComplete="off" placeholder="sk-ant-" data-tip="Stored in the AI daemon config at mode 600 and never read back into this window." onChange={(e) => setSecret(e.target.value)} />
        </label>
      </Choice>

      {saved ? <p className="setup-note"><span className="af-mono">Saved</span> {saved}</p> : null}
      {error ? <p className="setup-error">{error}</p> : null}
    </StepCard>
  );
}
