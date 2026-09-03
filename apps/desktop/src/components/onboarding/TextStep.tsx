import { useEffect, useRef, useState } from "react";
import { invoke, on } from "../../bridge";
import { StepCard } from "./parts";
import type { OnboardingTextInfo } from "../../../shared/types";

const ACCESS_LINE: Record<OnboardingTextInfo["accessibility"], string> = {
  granted: "Granted. Arcforma Text can read the selection and paste the fix back.",
  not_granted: "Not granted yet. Until it is, Cmd+J has nothing to read and says so.",
  unknown: "Not known yet. Arcforma Text answers this in its own log the moment it launches.",
};

/**
 * Arcforma Text: what Cmd+J does, an install that runs the real script with its
 * output on screen, and a live read of the Accessibility grant. The grant can
 * only be answered by the app itself, so checking restarts it and reads what it
 * wrote.
 */
export function TextStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [info, setInfo] = useState<OnboardingTextInfo | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState<"install" | "check" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    void invoke("onboarding:textState")
      .then((next) => live && setInfo(next))
      .catch((err) => live && setError((err as Error).message));
    const off = on("onboarding:progress", (p) => {
      if (p.kind !== "text") return;
      setLines((prev) => [...prev.slice(-200), p.line]);
    });
    return () => {
      live = false;
      off();
    };
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  const install = async () => {
    setBusy("install");
    setError(null);
    setLines([]);
    try {
      setInfo(await invoke("onboarding:installText"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    setBusy("check");
    setError(null);
    try {
      setInfo(await invoke("onboarding:checkAccessibility"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const granted = info?.accessibility === "granted";

  return (
    <StepCard
      eyebrow="Step 5 of 6"
      title="Fix text anywhere with Cmd+J."
      actions={
        <>
          <button className="btn btn-sweep" disabled={busy !== null || info?.scriptPresent === false} data-tip="Builds Arcforma Text, copies it to /Applications, and starts it through launchd. Takes a minute or two." onClick={() => void install()}>
            {busy === "install" ? "Building and installing" : info?.installed ? "Build and install again" : "Install Arcforma Text"}
          </button>
          <button className="btn btn-nav btn-compact" disabled={busy !== null} data-tip="Restarts Arcforma Text and reads its own answer about the Accessibility grant." onClick={() => void check()}>
            {busy === "check" ? "Checking" : "Check the grant"}
          </button>
          <button className="btn btn-nav btn-compact" data-tip="Goes to the last step. Mail works with or without the text tool." onClick={onNext}>
            {granted ? "Next" : "Skip for now"}
          </button>
          <button className="btn btn-ghost btn-compact" data-tip="Back to the local model." onClick={onBack}>
            Back
          </button>
        </>
      }
    >
      <p className="af-body">
        Arcforma Text is a separate menu-bar app that comes with this one. Select text in any app on the Mac, press Cmd+J, and its spelling, grammar, and punctuation are fixed in place; Cmd+Shift+J rewrites it from an instruction you
        type.
      </p>
      <p className="setup-note">
        It needs Accessibility, and only Accessibility: that covers reading the selected text and posting the paste back. It refuses terminals, password fields, and secure inputs, and it re-reads the selection before pasting so a
        selection that moved is never overwritten.
      </p>
      {info?.scriptPresent === false ? <p className="setup-note">This build does not carry the installer, so Arcforma Text has to be built from the repository with packages/text-tools/install.sh.</p> : null}

      <div className="setup-facts">
        <div className="setup-fact">
          <span className={`af-mono${info?.installed ? "" : " eyebrow-flag"}`}>{info?.installed ? "Installed" : "Not installed"}</span>
          <span className="setup-fact-name">{info?.appPath ?? "/Applications/Arcforma Text.app"}</span>
          <span className="setup-fact-detail">{info?.installed ? "launchd keeps it running and restarts it after a crash." : "Nothing is in /Applications yet."}</span>
        </div>
        <div className="setup-fact">
          <span className={`af-mono${granted ? "" : " eyebrow-flag"}`}>{granted ? "Accessibility granted" : "Accessibility"}</span>
          <span className="setup-fact-name">System Settings, Privacy and Security, Accessibility</span>
          <span className="setup-fact-detail">{info ? ACCESS_LINE[info.accessibility] : "Reading the log."}</span>
        </div>
      </div>

      {!granted ? (
        <div className="setup-links">
          <button className="btn btn-nav btn-compact" data-tip="Opens System Settings at Privacy and Security, Accessibility, where you switch Arcforma Text on." onClick={() => void invoke("onboarding:openAccessibility")}>
            Open the Accessibility settings
          </button>
        </div>
      ) : null}

      {lines.length ? (
        <div className="setup-log af-mono" ref={logRef} aria-label="Installer output">
          {lines.map((l, i) => (
            <div key={`${i}-${l.slice(0, 12)}`}>{l}</div>
          ))}
        </div>
      ) : null}
      {error ? <p className="setup-error">{error}</p> : null}
    </StepCard>
  );
}
