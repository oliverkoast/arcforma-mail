import type { Scope } from "./keymap";

/**
 * The pointer moves the cursor, never the scope.
 *
 * Hovering a row selects it, which is how the triage keys reach what the mouse is pointing at. That
 * is in ThreadList and is deliberate. What used to be here as well was a second rule moving the key
 * scope to "list" whenever the pointer was over a row, and that one was a mistake: Escape, O and the
 * instant replies 1, 2 and 3 are bound in "thread" and not in "list", so a pointer left over the
 * list while reading took those keys away with nothing on screen to say why.
 *
 * Nothing was lost by dropping it. Every triage key is bound in both scopes, so hovering a row and
 * pressing E works with the scope left alone, and Enter is now bound in "thread" as well so the row
 * under the pointer can be opened while another thread is on the right.
 *
 * Kept as a named function rather than deleted so the rule has somewhere to be stated and tested.
 */
export function scopeForPointer(current: Scope): Scope {
  return current;
}
