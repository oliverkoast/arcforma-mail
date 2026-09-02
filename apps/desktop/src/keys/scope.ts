import type { Scope } from "./keymap";

/** The surfaces that decide the key scope, from the app state. */
export interface ScopeState {
  settingsOpen: boolean;
  ask: { open: boolean };
  compose: unknown | null;
  snippetPickerOpen: boolean;
  sendLaterOpen: boolean;
  popover: unknown | null;
  /** The sidebar's add-a-row or row menu popover. */
  sidebarMenu: unknown | null;
  open: unknown | null;
}

/**
 * The active key scope follows whichever surface is on top, so Escape closes
 * the topmost thing first: a snooze popover, then settings, then Ask, then the
 * compose panel and its own overlays, then the reading pane back to the list.
 */
export function scopeFor(s: ScopeState): Scope {
  if (s.popover) return "popover";
  if (s.sidebarMenu) return "sidebar";
  if (s.settingsOpen) return "settings";
  if (s.ask.open) return "ask";
  if (s.compose) {
    if (s.snippetPickerOpen) return "snippets";
    if (s.sendLaterOpen) return "sendLater";
    return "compose";
  }
  return s.open ? "thread" : "list";
}
