import { useCallback, useMemo } from "react";
import { useApp } from "../state/store";
import { hiddenRows, layoutsEqual, moveRow, reconcileLayout, rowDescriptors, setRowHidden, visibleRows, type SidebarRowDescriptor } from "../lib/sidebarLayout";
import type { SidebarGroupId, SidebarLayout } from "../../shared/types";

/**
 * The sidebar's rows and their arrangement. Descriptors come from categories
 * and saved searches, the layout from the store, reconciled every render so a
 * new category or saved search shows up without a save. Only a user action
 * (drag, hide, show, adopt) writes the layout back.
 */
export function useSidebarLayout() {
  const categories = useApp((s) => s.categories);
  const searches = useApp((s) => s.savedSearches);
  const stored = useApp((s) => s.sidebarLayout);
  const save = useApp((s) => s.saveSidebarLayout);
  const rows = useMemo(() => rowDescriptors(categories, searches), [categories, searches]);
  const layout = useMemo(() => reconcileLayout(stored, rows), [stored, rows]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  const persist = useCallback(
    (next: SidebarLayout) => {
      if (!layoutsEqual(next, layout)) void save(next);
    },
    [layout, save]
  );

  const move = useCallback((rowId: string, group: SidebarGroupId, beforeId: string | null) => persist(moveRow(layout, rowId, group, beforeId)), [layout, persist]);
  const hide = useCallback((rowId: string) => persist(setRowHidden(layout, rowId, true)), [layout, persist]);
  const show = useCallback((rowId: string) => persist(setRowHidden(layout, rowId, false)), [layout, persist]);

  /**
   * Places a row that was just created into the group whose "+" made it,
   * reading the store fresh because the category or search list has moved
   * on since this render.
   */
  const adopt = useCallback(
    (rowId: string, group: SidebarGroupId) => {
      const s = useApp.getState();
      const fresh = reconcileLayout(s.sidebarLayout, rowDescriptors(s.categories, s.savedSearches));
      void s.saveSidebarLayout(moveRow(fresh, rowId, group, null));
    },
    []
  );

  const visible = useCallback((group: SidebarGroupId): SidebarRowDescriptor[] => visibleRows(layout, group, rows), [layout, rows]);
  const hidden = useMemo(() => hiddenRows(layout, rows), [layout, rows]);

  return { rows, byId, layout, visible, hidden, move, hide, show, adopt };
}
