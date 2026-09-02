// Key labels for tooltips come from the keymap, so a rebinding never leaves a
// stale hint on a button. Formatted the macOS way: Cmd+Shift+A, Enter, Esc.

import { KEYMAP, type Binding, type Scope } from "./keymap";

const KEY_NAMES: Record<string, string> = {
  Enter: "Enter",
  Escape: "Esc",
  Tab: "Tab",
  " ": "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Backspace: "Delete",
};

/** One binding as its label: modifiers in the macOS order, then the key. */
export function formatBinding(b: Pick<Binding, "key" | "meta" | "shift" | "alt">): string {
  const parts: string[] = [];
  if (b.meta) parts.push("Cmd");
  if (b.alt) parts.push("Option");
  if (b.shift) parts.push("Shift");
  const name = KEY_NAMES[b.key] ?? (b.key.length === 1 ? b.key.toUpperCase() : b.key);
  parts.push(name);
  return parts.join("+");
}

/**
 * The label for the first binding of an action, or null when nothing is bound.
 * Pass a scope to prefer the binding that applies there; without one, the
 * first row of the keymap wins.
 */
export function keyLabel(action: string, scope?: Scope): string | null {
  const scoped = scope ? KEYMAP.find((b) => b.action === action && b.scope === scope) : undefined;
  const b = scoped ?? KEYMAP.find((b) => b.action === action);
  return b ? formatBinding(b) : null;
}
