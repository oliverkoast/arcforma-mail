import { useState } from "react";
import { useApp } from "../state/store";
import { accountEyebrow } from "../../shared/accountState";
import { SidebarGroup } from "./SidebarGroup";
import { useSidebarLayout } from "./useSidebarLayout";
import { SIDEBAR_GROUPS, isActiveView, type SidebarRowDescriptor } from "../lib/sidebarLayout";
import { accountTip, sidebarRowTip } from "../lib/tips";
import { keyLabel } from "../keys/keyLabel";

/**
 * The left bar. Accounts and Settings are fixed; everything between is driven
 * by the sidebar layout: three groups of rows the user can reorder, hide, and
 * add to. Counts arrive in one payload from sidebar:counts.
 */
export function Sidebar() {
  const accounts = useApp((s) => s.status.accounts);
  const counts = useApp((s) => s.counts);
  const view = useApp((s) => s.view);
  const split = useApp((s) => s.split);
  const category = useApp((s) => s.category);
  const filter = useApp((s) => s.accountFilter);
  const drafts = useApp((s) => s.drafts);
  const categories = useApp((s) => s.categories);
  const savedSearches = useApp((s) => s.savedSearches);
  const menu = useApp((s) => s.sidebarMenu);
  const setView = useApp((s) => s.setView);
  const setAccountFilter = useApp((s) => s.setAccountFilter);
  const openAccountInbox = useApp((s) => s.openAccountInbox);
  const openSettings = useApp((s) => s.openSettings);
  const openSidebarMenu = useApp((s) => s.openSidebarMenu);
  const { visible, move } = useSidebarLayout();
  const [dragId, setDragId] = useState<string | null>(null);
  const signedIn = accounts.some((a) => a.authState !== "signed_out");

  const isActive = (row: SidebarRowDescriptor) => isActiveView(row.view, { view, split, category });
  const countOf = (row: SidebarRowDescriptor) => (row.id === "drafts" ? drafts.length : row.count(counts));
  const open = (row: SidebarRowDescriptor) => setView(row.view.view, { split: row.view.split ?? null, category: row.view.category ?? null });

  return (
    <aside className="sidebar">
      <div className="sidebar-top drag" />
      <img className="wordmark" src="/brand/logos/arcforma-wordmark-ink.svg" width={120} alt="Arcforma" />

      <div className="nav-group">
        <div className="af-mono nav-eyebrow">Accounts</div>
        <button className="nav-item" aria-current={filter === null ? "true" : undefined} data-tip="Every account in one list. The count is unread mail across all of them." onClick={() => setAccountFilter(null)} disabled={!signedIn}>
          <span className="nav-label">All inboxes</span>
          {counts.unread ? <span className="nav-count">{counts.unread}</span> : null}
        </button>
        {accounts.map((a) => {
          const sub = accountEyebrow(a);
          return (
            <button
              key={a.id}
              className="nav-item"
              aria-current={filter === a.id ? "true" : undefined}
              data-tip={accountTip(a)}
              onClick={() => setAccountFilter(a.id)}
              onDoubleClick={() => openAccountInbox(a.id)}
              disabled={!signedIn}
            >
              <span className="nav-label">
                {a.email}
                {sub ? <span className="af-mono nav-sub">{sub}</span> : null}
              </span>
            </button>
          );
        })}
      </div>

      {SIDEBAR_GROUPS.map((g) => (
        <SidebarGroup
          key={g.id}
          id={g.id}
          label={g.label}
          rows={visible(g.id)}
          disabled={!signedIn}
          isActive={isActive}
          countOf={countOf}
          tipOf={(row) => sidebarRowTip(row, categories, savedSearches)}
          menuRowId={menu?.kind === "row" ? menu.rowId : null}
          addOpen={menu?.kind === "add" && menu.group === g.id}
          onOpen={open}
          onAdd={(anchor) => openSidebarMenu({ kind: "add", group: g.id, anchor })}
          onRowMenu={(row, anchor) => openSidebarMenu({ kind: "row", rowId: row.id, anchor })}
          dragId={dragId}
          setDragId={setDragId}
          onMove={move}
        />
      ))}

      <div className="nav-group nav-bottom">
        <button className="nav-item" data-tip="Accounts, sending, startup, snippets, and categories." data-key={keyLabel("settings") ?? undefined} onClick={openSettings}>
          <span className="nav-label">Settings</span>
          <span className="nav-count af-mono">Cmd+,</span>
        </button>
      </div>
    </aside>
  );
}
