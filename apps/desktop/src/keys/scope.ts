import type { Scope } from "./keymap";

/** The surfaces that decide the key scope, from the app state. */
export interface ScopeState {
  /** First-run setup owns the whole window, so no app shortcut fires behind it. */
  onboardingOpen?: boolean;
  /** The command palette (Cmd+K). It sits above everything, so Escape closes it before anything under it. */
  paletteOpen: boolean;
  settingsOpen: boolean;
  ask: { open: boolean };
  compose: unknown | null;
  /** An inline reply collapsed to its strip: the draft is kept, but nobody is typing in it. */
  inlineCollapsed: boolean;
  snippetPickerOpen: boolean;
  sendLaterOpen: boolean;
  popover: unknown | null;
  /** The sidebar's add-a-row or row menu popover. */
  sidebarMenu: unknown | null;
  open: unknown | null;
}

/**
 * The active key scope follows whichever surface is on top, so Escape closes
 * the topmost thing first: the command palette, then a snooze popover, then
 * settings, then Ask, then the compose panel and its own overlays, then the
 * reading pane back to the list.
 * An inline reply collapsed to its strip hands the keys back to the thread:
 * J and K move, R reopens the draft. Setup sits above all of it: while it is
 * open no shortcut resolves at all, so nothing behind it can be archived by a
 * stray keystroke.
 */
export function scopeFor(s: ScopeState): Scope {
  if (s.onboardingOpen) return "setup";
  if (s.paletteOpen) return "palette";
  if (s.popover) return "popover";
  if (s.sidebarMenu) return "sidebar";
  if (s.settingsOpen) return "settings";
  if (s.ask.open) return "ask";
  if (s.compose && !s.inlineCollapsed) {
    if (s.snippetPickerOpen) return "snippets";
    if (s.sendLaterOpen) return "sendLater";
    return "compose";
  }
  return s.open ? "thread" : "list";
}
