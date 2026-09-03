import { useEffect } from "react";
import { installKeyDispatcher, type ActionMap } from "./dispatcher";
import { SEND_LATER, useApp } from "../state/store";
import { inDays, nextMondayMorning, tomorrowMorning } from "../lib/format";

/**
 * Every keymap action as a function on the store. The key dispatcher runs
 * them on keydown; the command palette runs the same ones by name, so a
 * command in the palette can never drift from what its key does.
 */
export function appActions(): ActionMap {
  const s = () => useApp.getState();
  const focusSearch = () => {
    const el = document.getElementById("search-input") as HTMLInputElement | null;
    el?.focus();
    el?.select();
  };
  return {
    next: () => s().move(1),
    prev: () => s().move(-1),
    archive: () => void s().archiveSelected(),
    moveToInbox: () => void s().moveToInboxSelected(),
    toggleAllMessages: () => s().toggleAllMessages(),
    compose: () => s().openCompose("new"),
    search: focusSearch,
    snooze: () => {
      if (s().rows.length) s().setPopover("snooze");
    },
    star: () => void s().starSelected(),
    toggleDaily: () => void s().toggleQueue("daily"),
    toggleWeekly: () => void s().toggleQueue("weekly"),
    reply: () => s().openCompose("reply"),
    replyAll: () => s().openCompose("replyAll"),
    forward: () => s().openCompose("forward"),
    undo: () => void s().undo(),
    open: () => void s().openSelected(),
    close: () => s().closeThread(),
    closePopover: () => s().setPopover(null),
    closeSidebarMenu: () => s().closeSidebarMenu(),
    leaveSearch: () => s().leaveSearch(),
    runSearch: () => void s().runSearch(),
    instantReply1: () => s().acceptInstantReply(1),
    instantReply2: () => s().acceptInstantReply(2),
    instantReply3: () => s().acceptInstantReply(3),
    acceptDraft: () => s().acceptGhost(),
    closeCompose: () => void s().dismissCompose(),
    toggleReadingPane: () => s().toggleReadingPane(),
    discardCompose: () => void s().closeCompose(false),
    send: () => void s().sendCompose(null),
    sendLater: () => s().setSendLater(true),
    closeSendLater: () => s().setSendLater(false),
    sendTomorrow: () => void s().sendCompose(SEND_LATER.tomorrow()),
    sendNextMonday: () => void s().sendCompose(SEND_LATER.nextMonday()),
    sendPick: () => s().setSendLater(true, true),
    snippets: () => s().setSnippetPicker(true),
    closeSnippets: () => s().setSnippetPicker(false),
    toggleCalendar: () => s().toggleRail("calendar"),
    toggleContact: () => s().toggleRail("contact"),
    ask: () => s().openAsk(),
    closeAsk: () => s().closeAsk(),
    runAsk: () => void s().runAsk(),
    settings: () => s().openSettings(),
    closeSettings: () => s().closeSettings(),
    snoozeTomorrow: () => void s().snoozeSelected(tomorrowMorning()),
    snoozeNextWeek: () => void s().snoozeSelected(nextMondayMorning()),
    snoozePick: () => s().setPopover("snoozePick"),
    remindThreeDays: () => {
      s().setPopover(null);
      void s().remindSelected(inDays(3));
    },
    unsubscribe: () => void s().unsubscribeSelected(),
    palette: () => s().togglePalette(),
    closePalette: () => s().closePalette(),
  };
}

export function useKeyboard(): void {
  useEffect(
    () =>
      installKeyDispatcher(() => useApp.getState().scope, appActions(), {
        goTo: (view) => useApp.getState().setView(view),
        onArmed: (armedNow) => useApp.setState({ goToArmed: armedNow }),
      }),
    []
  );
}
