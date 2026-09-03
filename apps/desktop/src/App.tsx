import { useHoverScope } from "./keys/useHoverScope";
import { PaneSplitter } from "./components/PaneSplitter";
import { useEffect } from "react";
import { AddRowPopover } from "./components/AddRowPopover";
import { AskPanel } from "./components/AskPanel";
import { CommandPalette } from "./components/CommandPalette";
import { Compose } from "./components/Compose";
import { NoAccounts, Onboarding } from "./components/Onboarding";
import { ReadingPane } from "./components/ReadingPane";
import { RightRail } from "./components/RightRail";
import { Settings } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { SnoozePopover } from "./components/SnoozePopover";
import { SyncSplash } from "./components/SyncSplash";
import { ThreadList } from "./components/ThreadList";
import { Toast } from "./components/Toast";
import { GoToChip } from "./components/GoToChip";
import { Tooltip } from "./components/Tooltip";
import { useKeyboard } from "./keys/useKeyboard";
import { useApp } from "./state/store";

export function App() {
  const ready = useApp((s) => s.ready);
  const accounts = useApp((s) => s.status.accounts);
  const rail = useApp((s) => s.rail);
  const readingPane = useApp((s) => s.readingPane);
  const rows = useApp((s) => s.rows);
  const init = useApp((s) => s.init);
  useEffect(() => {
    void init();
  }, [init]);
  useKeyboard();
  useHoverScope();

  const onboardingOpen = useApp((s) => s.onboardingOpen);
  const signedIn = accounts.some((a) => a.authState !== "signed_out");
  const backfilling = accounts.some((a) => a.authState === "ok" && (a.syncState === "backfill" || a.syncState === "new"));
  const showSplash = ready && signedIn && backfilling && rows.length === 0;

  return (
    <div className={`app af-body${rail !== "none" ? " has-rail" : ""}${readingPane ? "" : " no-reading"}`}>
      <Sidebar />
      {!ready ? null : signedIn || onboardingOpen ? (
        <>
          <ThreadList />
          {readingPane ? <PaneSplitter /> : null}
          {readingPane ? <ReadingPane /> : null}
          {rail !== "none" && <RightRail />}
        </>
      ) : (
        <NoAccounts />
      )}
      {ready && onboardingOpen ? <Onboarding /> : null}
      {showSplash && !onboardingOpen && <SyncSplash />}
      <SnoozePopover />
      <AddRowPopover />
      <Compose />
      <AskPanel />
      <Settings />
      <CommandPalette />
      <GoToChip />
      <Toast />
      <Tooltip />
    </div>
  );
}
