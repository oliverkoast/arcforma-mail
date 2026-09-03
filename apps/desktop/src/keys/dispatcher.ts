import { KEYMAP, TYPING_SCOPES, resolveGoTo, type Binding, type Scope } from "./keymap";
import type { InboxView } from "../../shared/types";

export type ActionMap = Record<string, () => void>;

/** How long an armed G waits for its second key before giving up. */
export const GO_TO_TIMEOUT_MS = 2500;

export interface PrefixHooks {
  /** Runs when G and a mapped letter complete. */
  goTo: (view: InboxView) => void;
  /** Told whenever the armed state changes, so the window can show that G is waiting. */
  onArmed?: (armed: boolean) => void;
}

/** Whether G should arm the go-to prefix rather than reaching the keymap: never while typing. */
export function armsGoTo(scope: Scope, e: KeyLike, editable: boolean): boolean {
  if (scope === "setup") return false;
  if (editable || TYPING_SCOPES.has(scope)) return false;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  return normalizeKey(e.key) === "g";
}

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
export function installKeyDispatcher(getScope: () => Scope, actions: ActionMap, prefix?: PrefixHooks): () => void {
  let armed = false;
  let armedTimer: ReturnType<typeof setTimeout> | null = null;
  const setArmed = (next: boolean) => {
    if (armedTimer) clearTimeout(armedTimer);
    armedTimer = null;
    if (armed !== next) {
      armed = next;
      prefix?.onArmed?.(next);
    }
    // A G left hanging is a G that will surprise its owner later, so it expires on its own.
    if (next) armedTimer = setTimeout(() => setArmed(false), GO_TO_TIMEOUT_MS);
  };

  const handler = (e: KeyboardEvent) => {
    if (e.isComposing || e.defaultPrevented) return;
    if (e.repeat && e.key !== "j" && e.key !== "k") return;
    const editable = isEditable(e.target);

    // A key that completes an armed G never also does what it means on its own: G then E goes to
    // Done, it does not archive the selected thread.
    if (armed && prefix) {
      setArmed(false);
      if (e.key === "Escape") {
        e.preventDefault();
        return;
      }
      const target = e.metaKey || e.ctrlKey || e.altKey ? null : resolveGoTo(e.key);
      if (target) {
        e.preventDefault();
        e.stopPropagation();
        prefix.goTo(target.view);
        return;
      }
      // An unmapped letter simply disarms and is otherwise ignored, rather than firing whatever it
      // would have meant: the person was in the middle of a chord, not issuing a command.
      e.preventDefault();
      return;
    }
    if (prefix && armsGoTo(getScope(), e, editable)) {
      e.preventDefault();
      setArmed(true);
      return;
    }

    const b = resolveBinding(getScope(), e, editable);
    if (!b) return;
    const run = actions[b.action];
    if (!run) return;
    e.preventDefault();
    e.stopPropagation();
    run();
  };
  window.addEventListener("keydown", handler);
  return () => {
    if (armedTimer) clearTimeout(armedTimer);
    window.removeEventListener("keydown", handler);
  };
}
