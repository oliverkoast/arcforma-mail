import { Component, type ErrorInfo, type ReactNode } from "react";
import { invoke } from "../bridge";

/**
 * What the window shows when the interface itself fails.
 *
 * React unmounts the whole tree when a render throws, so without this a single bad message body or
 * one undefined field turns the app into a white rectangle: no error, no menu, no way back, and
 * nothing written down. Mail is still there and still syncing underneath, so the honest thing is to
 * say what broke, record it where it can be read later, and offer the two ways out that work.
 *
 * Reloading is offered before quitting because the fault is usually in one thread's rendering, and
 * a reload lands back in the list rather than in the thread that broke.
 */
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Straight to the main process, because the log file is the only record that outlives the window.
    void invoke("app:reportCrash", {
      message: error.message,
      stack: error.stack ?? null,
      componentStack: info.componentStack ?? null,
    }).catch(() => {
      // A crash report that cannot be filed must not itself crash the crash screen.
    });
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash">
        <div className="crash-card">
          <span className="af-mono">SOMETHING BROKE</span>
          <div className="af-h3">The window stopped drawing.</div>
          <p>Your mail is untouched and still syncing. Reloading usually lands you back in the list.</p>
          <p className="crash-detail">{error.message}</p>
          <div className="crash-actions">
            <button className="btn btn-sweep btn-compact" onClick={() => window.location.reload()}>
              Reload the window
            </button>
            <button className="btn btn-nav btn-compact" onClick={() => void invoke("app:openLogFolder")}>
              Open the log
            </button>
          </div>
        </div>
      </div>
    );
  }
}
