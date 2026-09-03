import { useEffect, useState } from "react";
import { invoke, on } from "../../bridge";
import { downloadLine, downloadPercent, readableSize } from "../../../shared/onboarding";
import { FactRow, ProgressBar, StepCard } from "./parts";
import type { OnboardingModelInfo } from "../../../shared/types";

/**
 * The local model: what is on the Mac, and a download for the part that is
 * missing. The size is on screen before anything starts, the bar is real
 * bytes, Cancel stops it, and a stopped download keeps what it had so the next
 * start resumes rather than begins again.
 */
export function ModelStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [info, setInfo] = useState<OnboardingModelInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    void invoke("onboarding:modelState")
      .then((next) => {
        if (!live) return;
        setInfo(next);
        setLoading(false);
      })
      .catch((err) => {
        if (!live) return;
        setError((err as Error).message);
        setLoading(false);
      });
    const off = on("onboarding:progress", (p) => {
      if (p.kind !== "model") return;
      setInfo((prev) => (prev ? { ...prev, download: p.state, modelPresent: p.state.phase === "done" ? true : prev.modelPresent } : prev));
    });
    return () => {
      live = false;
      off();
    };
  }, []);

  const download = info?.download ?? { phase: "idle" as const, received: 0, total: null, resumed: false, file: null, error: null };
  const running = download.phase === "starting" || download.phase === "downloading";
  const percent = downloadPercent(download);

  const start = () => {
    setError(null);
    void invoke("onboarding:downloadModel")
      .then(setInfo)
      .catch((err) => setError((err as Error).message));
  };
  const cancel = () => {
    void invoke("onboarding:cancelModel")
      .then(setInfo)
      .catch((err) => setError((err as Error).message));
  };

  const ready = Boolean(info?.modelPresent && info?.binaryPresent);

  return (
    <StepCard
      eyebrow="Step 4 of 6"
      title="The model that sorts your mail."
      actions={
        <>
          {running ? (
            <button className="btn btn-nav btn-compact" data-tip="Stops the download. What has arrived is kept, and starting again carries on from there." onClick={cancel}>
              Stop the download
            </button>
          ) : info && !info.modelPresent ? (
            <button className="btn btn-sweep" disabled={loading} data-tip={`Downloads ${readableSize(info.catalog.bytes)} from Hugging Face into ${info.modelsDir}.`} onClick={start}>
              Download {readableSize(info.catalog.bytes)}
            </button>
          ) : null}
          <button className="btn btn-nav btn-compact" data-tip="Goes on to the text tool. Background sorting stays off until a model is in place." onClick={onNext}>
            {ready ? "Next" : "Skip for now"}
          </button>
          <button className="btn btn-ghost btn-compact" data-tip="Back to the AI choice." onClick={onBack}>
            Back
          </button>
        </>
      }
    >
      <p className="af-body">
        Every incoming thread is read by a small model on this Mac and filed into Newsletters, Promotions, Jobs, Calendar, Notifications, or Receipts. It needs two things: the llama.cpp server binary that runs it, and the model file
        itself.
      </p>
      <div className="setup-facts">
        <FactRow label="llama.cpp server binary" ok={Boolean(info?.binaryPresent)} detail={info?.binaryPath ? info.binaryPath : "The AI daemon config names no binary. Build llama.cpp or point local.binary at one, then come back."} />
        <FactRow label={info?.catalog.name ?? "The model file"} ok={Boolean(info?.modelPresent)} detail={info ? `${info.modelPath} (${readableSize(info.catalog.bytes)})` : "Reading the daemon config."} />
      </div>

      {running || download.phase !== "idle" ? (
        <>
          <ProgressBar percent={percent} />
          <p className="setup-note">
            <span className="af-mono">{download.phase === "failed" ? "Failed" : download.phase === "cancelled" ? "Stopped" : download.phase === "done" ? "Done" : "Downloading"}</span> {downloadLine(download)}
          </p>
        </>
      ) : null}

      {!info?.binaryPresent ? (
        <p className="setup-note">Without the binary the model file alone changes nothing. Background sorting stays off, header rules keep filing what they can, and the app works otherwise.</p>
      ) : null}
      {!info?.modelPresent && !running ? (
        <p className="setup-note">Skipping is fine. Background sorting stays off, so mail arrives unsorted beyond the header rules, and Daily 0 fills from the attention model rather than the local one. You can download it later from Settings.</p>
      ) : null}
      {error ? <p className="setup-error">{error}</p> : null}
    </StepCard>
  );
}
