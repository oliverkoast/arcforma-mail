import { useEffect } from "react";
import { useApp } from "../state/store";
import { scopeForPointer } from "./hoverScope";

/** Follows the pointer between the list and the reading pane so E, S, H, D, W act on what is under the mouse. */
export function useHoverScope(): void {
  useEffect(() => {
    let last: { list: boolean; reading: boolean } | null = null;
    const onMove = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t || typeof t.closest !== "function") return;
      const overList = Boolean(t.closest(".rows .row"));
      const overReading = Boolean(t.closest(".reading"));
      if (last && last.list === overList && last.reading === overReading) return;
      last = { list: overList, reading: overReading };
      const s = useApp.getState();
      const next = scopeForPointer(s.scope, overList, overReading);
      if (next !== s.scope) s.setScope(next);
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, []);
}
