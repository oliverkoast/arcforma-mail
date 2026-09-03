import { StepCard } from "./parts";

const KEYS: Array<[string, string]> = [
  ["J and K", "Move down and up the list. They work in the list and inside an open thread."],
  ["E", "Mark done. In Daily 0 it clears the thread and lands you on the next one."],
  ["C", "Compose. R, A, and F reply, reply all, and forward inside the open thread."],
  ["Cmd+K", "The command palette. Every action in the app by name, with its key next to it."],
];

/** The last screen: the four keys worth knowing, what Daily 0 is, and the way in. */
export function DoneStep({ onFinish, onBack }: { onFinish: () => void; onBack: () => void }) {
  return (
    <StepCard
      eyebrow="Step 6 of 6"
      title="That is setup. Here is the whole app in four keys."
      actions={
        <>
          <button className="btn btn-sweep" data-tip="Closes setup and opens your inbox. Settings has a Run setup again button if you need this flow back." onClick={onFinish}>
            Start reading
          </button>
          <button className="btn btn-ghost btn-compact" data-tip="Back to the text tool." onClick={onBack}>
            Back
          </button>
        </>
      }
    >
      <div className="setup-facts">
        {KEYS.map(([key, what]) => (
          <div className="setup-fact" key={key}>
            <span className="af-mono">{key}</span>
            <span className="setup-fact-detail">{what}</span>
          </div>
        ))}
      </div>
      <p className="af-body">
        Daily 0 is the one commitment the app asks for. It holds every important thread with new mail since you were last on mail the night before, plus anything you added with D and every snooze that woke today. Clear it with E and the
        day is done. Weekly 0 takes W and whatever was left when the day rolled over.
      </p>
      <p className="setup-note">Everything in this flow lives in Settings: accounts, the AI choice, and a Run setup again button that brings these six screens back.</p>
    </StepCard>
  );
}
