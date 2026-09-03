import { KEYMAP, TYPING_SCOPES, type Binding, type Scope } from "./keymap";

export type ActionMap = Record<string, () => void>;

/** The subset of KeyboardEvent the resolver reads, so node:test can drive it. */
export interface KeyLike {
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

export function matches(b: Binding, e: KeyLike): boolean {
  if (normalizeKey(e.key) !== normalizeKey(b.key)) return false;
  if (Boolean(b.meta) !== e.metaKey) return false;
  if (Boolean(b.shift) !== e.shiftKey) return false;
  if (Boolean(b.alt) !== e.altKey) return false;
  return !e.ctrlKey;
}

const PASSTHROUGH = new Set(["Escape", "Tab", "Enter"]);

/**
 * Picks the binding for a key in a scope. Pure, so the compose guard is
 * testable: while typing (an editable target, or any typing scope) a plain
 * letter never resolves to anything, only Cmd chords, Escape, Tab, and Enter.
 */
export function resolveBinding(scope: Scope, e: KeyLike, editable: boolean): Binding | null {
  // First-run setup is its own window. Nothing behind it may be reached, not even a global chord.
  if (scope === "setup") return null;
  const typing = editable || TYPING_SCOPES.has(scope);
  for (const b of KEYMAP) {
    if (b.scope !== scope && b.scope !== "global") continue;
    if (!matches(b, e)) continue;
    if (typing && !b.meta && !PASSTHROUGH.has(b.key)) continue;
    return b;
  }
  return null;
}

/**
 * Single window keydown dispatcher. Anything the editor already handled
 * (defaultPrevented) is left alone, so a Tab that expanded a snippet never
 * also accepts an auto-draft.
 */
export function installKeyDispatcher(getScope: () => Scope, actions: ActionMap): () => void {
  const handler = (e: KeyboardEvent) => {
    if (e.isComposing || e.defaultPrevented) return;
    if (e.repeat && e.key !== "j" && e.key !== "k") return;
    const b = resolveBinding(getScope(), e, isEditable(e.target));
    if (!b) return;
    const run = actions[b.action];
    if (!run) return;
    e.preventDefault();
    e.stopPropagation();
    run();
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}
