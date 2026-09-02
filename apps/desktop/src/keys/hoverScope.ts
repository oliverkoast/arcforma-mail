import type { Scope } from "./keymap";

/**
 * Where the mouse is decides what the triage keys act on. Over a list row the row under the
 * pointer is the target (the hover already made it the current row); over the reading pane the
 * open thread is. Typing scopes and overlays are never changed by the pointer.
 */
export function scopeForPointer(current: Scope, overList: boolean, overReading: boolean): Scope {
  if (current !== "list" && current !== "thread") return current;
  if (overList) return "list";
  if (overReading) return "thread";
  return current;
}
