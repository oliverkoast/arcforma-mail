import { ONBOARDING_STEPS, STEP_TITLES, nextStepId, prevStepId, stepIndex } from "../../shared/onboarding";
import { useApp } from "../state/store";
import { AccountStep } from "./onboarding/AccountStep";
import { AiStep } from "./onboarding/AiStep";
import { DoneStep } from "./onboarding/DoneStep";
import { ModelStep } from "./onboarding/ModelStep";
import { TextStep } from "./onboarding/TextStep";
import { WelcomeStep } from "./onboarding/WelcomeStep";

/**
 * First run, one screen at a time. It owns the whole window until somebody
 * presses Start reading, every step can be skipped, and the step on screen is
 * written to the settings table on each move, so a quit halfway comes back
 * here rather than to a half-configured inbox.
 */
/**
 * What the shell shows when setup is finished but no account ever connected:
 * an inbox with nothing behind it would be a lie, so this says so and offers
 * the two ways back.
 */
export function NoAccounts() {
  const reopen = useApp((s) => s.reopenOnboarding);
  const openSettings = useApp((s) => s.openSettings);
  const configError = useApp((s) => s.status.configError);
  return (
    <section className="onboarding" aria-label="No account connected">
      <div className="onboarding-card">
        <span className="af-mono">Accounts</span>
        <h1 className="af-h2">No mailbox is connected yet.</h1>
        <p className="af-body">Setup is marked finished and no account signed in, so there is nothing to read. Run setup again to add one, or open Settings if the credentials are already in place and only the sign-in is missing.</p>
        {configError ? (
          <div className="notice">
            <span className="af-mono">Setup</span>
            <span>{configError}</span>
          </div>
        ) : null}
        <div className="setup-actions">
          <button className="btn btn-sweep btn-compact" data-tip="Reopens the six setup screens, starting at what the app is." onClick={reopen}>
            Run setup again
          </button>
          <button className="btn btn-nav btn-compact" data-tip="Opens Settings, where each account has its own Sign in button." onClick={openSettings}>
            Open Settings
          </button>
        </div>
      </div>
    </section>
  );
}

export function Onboarding() {
  const step = useApp((s) => s.onboarding?.step ?? "welcome");
  const goToStep = useApp((s) => s.goToOnboardingStep);
  const finish = useApp((s) => s.finishOnboarding);
  const here = stepIndex(step);
  const back = () => {
    const prev = prevStepId(step);
    if (prev) goToStep(prev);
  };
  const next = () => goToStep(nextStepId(step));

  return (
    <section className="setup" aria-label="Set up Arcforma Mail">
      <div className="setup-rail">
        <div className="setup-top drag" />
        <img className="wordmark" src="/brand/logos/arcforma-wordmark-ink.svg" width={120} alt="Arcforma" />
        <ol className="setup-steps">
          {ONBOARDING_STEPS.map((id, i) => (
            <li key={id}>
              <button
                className={`setup-step${i === here ? " is-here" : ""}${i < here ? " is-done" : ""}`}
                aria-current={i === here ? "step" : undefined}
                data-tip={i <= here ? `Back to ${STEP_TITLES[id].toLowerCase()}.` : "Finish the steps before this one first."}
                disabled={i > here}
                onClick={() => goToStep(id)}
              >
                <span className="af-mono setup-step-n">{i + 1}</span>
                <span className="setup-step-name">{STEP_TITLES[id]}</span>
              </button>
            </li>
          ))}
        </ol>
        <p className="setup-rail-note">Everything here can be skipped and picked up later from Settings.</p>
      </div>
      <div className="setup-main">
        {step === "welcome" ? <WelcomeStep onNext={next} /> : null}
        {step === "accounts" ? <AccountStep onNext={next} onBack={back} /> : null}
        {step === "ai" ? <AiStep onNext={next} onBack={back} /> : null}
        {step === "model" ? <ModelStep onNext={next} onBack={back} /> : null}
        {step === "text" ? <TextStep onNext={next} onBack={back} /> : null}
        {step === "done" ? <DoneStep onFinish={finish} onBack={back} /> : null}
      </div>
    </section>
  );
}
