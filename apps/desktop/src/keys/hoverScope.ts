import type { Scope } from "./keymap";

/**
 * The pointer does not decide what the keys do.
 *
 * This used to move the key scope to "list" whenever the mouse was over a row. It was written to
 * pair with the list moving its cursor on hover, and both are gone for the same reason: where a
 * mouse happens to be resting is not a statement of intent, and reading intent off it made the
 * keyboard unpredictable. Two concrete faults it caused:
 *
 *   E archived whatever the pointer was over rather than the thread on screen.
 *
 *   While reading a thread, a pointer left over the list put the scope in "list", where Escape, O
 *   and the instant-reply keys 1, 2 and 3 are not bound at all. Those keys silently stopped
 *   working, with nothing on screen to say why.
 *
 * The scope now follows what is open, which is the thing the person is looking at. Every triage key
 * is bound in both scopes, so nothing was lost by no longer switching between them.
 *
 * Kept as a named function rather than deleted so the rule has somewhere to be stated and tested.
 */
export function scopeForPointer(current: Scope): Scope {
  return current;
}
