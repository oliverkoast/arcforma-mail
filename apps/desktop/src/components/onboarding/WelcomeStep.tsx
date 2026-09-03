import { StepCard } from "./parts";

/**
 * What the app is, and what it does with your mail. The three sentences match
 * the README, and the list underneath is the part people actually want to know:
 * what stays on this Mac and what does not.
 */
export function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <StepCard
      eyebrow="Arcforma Mail"
      title="A mail client for people who want their inbox back."
      actions={
        <button className="btn btn-sweep" data-tip="Goes to the first step: adding a Gmail account." onClick={onNext}>
          Get started
        </button>
      }
    >
      <p className="af-body">
        It reads your Gmail, sorts it with a model running on your own machine, and gets out of the way. Several accounts land in one split inbox with Daily 0 and Weekly 0 queues, a keyboard flow, snooze, send later, and search that
        understands operators. Setup takes about twenty minutes, most of it in the Google Cloud console, and this flow walks every click.
      </p>
      <div className="setup-facts">
        <div className="setup-fact">
          <span className="af-mono">Stays here</span>
          <span className="setup-fact-name">Your mail and your tokens</span>
          <span className="setup-fact-detail">Messages live in a SQLite file in this app's data folder. Refresh tokens are encrypted by macOS and never leave the Mac. There are no tracking pixels and there never will be.</span>
        </div>
        <div className="setup-fact">
          <span className="af-mono">Stays here</span>
          <span className="setup-fact-name">Background sorting</span>
          <span className="setup-fact-detail">A 4B model runs locally through llama.cpp and decides what is important. Nothing it reads is sent anywhere.</span>
        </div>
        <div className="setup-fact">
          <span className="af-mono">Leaves</span>
          <span className="setup-fact-name">Summaries, drafts, and Ask, when you press the key</span>
          <span className="setup-fact-detail">Those go to Claude through your own Claude Code login or your own Anthropic key, so the thread you asked about leaves the Mac. Nothing goes on its own, and you can turn this off entirely.</span>
        </div>
        <div className="setup-fact">
          <span className="af-mono">Leaves</span>
          <span className="setup-fact-name">Requests to Google</span>
          <span className="setup-fact-detail">Gmail, Calendar, and Contacts are called directly with OAuth clients you create in your own Google Cloud project. No server of ours sits in between, because there is no server of ours.</span>
        </div>
      </div>
    </StepCard>
  );
}
