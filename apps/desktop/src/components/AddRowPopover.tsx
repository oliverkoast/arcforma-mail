import { useEffect, useRef, useState } from "react";
import { useApp, type SidebarMenu } from "../state/store";
import { useSidebarLayout } from "./useSidebarLayout";
import { SIDEBAR_GROUPS, type SidebarRowDescriptor } from "../lib/sidebarLayout";
import type { SidebarGroupId } from "../../shared/types";

const WIDTH = 300;

type AddMode = "menu" | "category" | "search" | "hidden";
type RowMode = "menu" | "rename" | "remove";

function Field({ label, value, onChange, placeholder, autoFocus }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; autoFocus?: boolean }) {
  return (
    <label className="compose-field">
      <span className="af-mono">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus} spellCheck={false} />
    </label>
  );
}

function Actions({ submit, disabled, onSubmit, onCancel }: { submit: string; disabled: boolean; onSubmit: () => void; onCancel: () => void }) {
  return (
    <div className="settings-actions">
      <button className="btn btn-sweep btn-compact" disabled={disabled} onClick={onSubmit}>
        {submit}
      </button>
      <button className="btn btn-ghost btn-compact" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

function Option({ label, sub, onClick, disabled }: { label: string; sub: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button className="popover-item" onClick={onClick} disabled={disabled}>
      <span>{label}</span>
      <span className="popover-sub">{sub}</span>
    </button>
  );
}

/** The "+" popover: a new category, a new saved search, or a hidden row back. */
function AddMenu({ group, close }: { group: SidebarGroupId; close: () => void }) {
  const createCategory = useApp((s) => s.createCategory);
  const createSavedSearch = useApp((s) => s.createSavedSearch);
  const { hidden, show, adopt } = useSidebarLayout();
  const [mode, setMode] = useState<AddMode>("menu");
  const [name, setName] = useState("");
  const [detail, setDetail] = useState("");
  const groupLabel = SIDEBAR_GROUPS.find((g) => g.id === group)?.label ?? "";

  const addCategory = async () => {
    const before = new Set(useApp.getState().categories.map((c) => c.id));
    await createCategory(name, detail);
    const added = useApp.getState().categories.find((c) => !before.has(c.id));
    if (added) adopt(`category:${added.id}`, group);
    close();
  };
  const addSearch = async () => {
    if (!(await createSavedSearch(name, detail))) return;
    const newest = useApp.getState().savedSearches.reduce<number>((m, s) => Math.max(m, s.id), 0);
    if (newest) adopt(`search:${newest}`, group);
    close();
  };

  if (mode === "category") {
    return (
      <>
        <span className="af-mono">New category in {groupLabel}</span>
        <Field label="Name" value={name} onChange={setName} placeholder="Clients" autoFocus />
        <Field label="What belongs" value={detail} onChange={setDetail} placeholder="Mail from paying clients about their engagement." />
        <Actions submit="Add category and re-sort 30 days" disabled={!name.trim() || !detail.trim()} onSubmit={() => void addCategory()} onCancel={close} />
      </>
    );
  }
  if (mode === "search") {
    return (
      <>
        <span className="af-mono">New saved search in {groupLabel}</span>
        <Field label="Name" value={name} onChange={setName} placeholder="Northwind" autoFocus />
        <Field label="Query" value={detail} onChange={setDetail} placeholder="northwind invoice" />
        <span className="popover-sub">Same words as the / search: subject, sender, recipients, and message text.</span>
        <Actions submit="Add saved search" disabled={!name.trim() || !detail.trim()} onSubmit={() => void addSearch()} onCancel={close} />
      </>
    );
  }
  if (mode === "hidden") {
    return (
      <>
        <span className="af-mono">Hidden rows</span>
        {hidden.length === 0 ? <span className="popover-sub">Every row is showing.</span> : null}
        {hidden.map((r) => (
          <button
            className="popover-item"
            key={r.id}
            onClick={() => {
              show(r.id);
              close();
            }}
          >
            <span>Show {r.label}</span>
          </button>
        ))}
        <Actions submit="Back" disabled={false} onSubmit={() => setMode("menu")} onCancel={close} />
      </>
    );
  }
  return (
    <>
      <span className="af-mono">Add a row to {groupLabel}</span>
      <Option label="Category" sub="Name it and say what belongs. The local model files mail into it." onClick={() => setMode("category")} />
      <Option label="Saved search" sub="A name and a query in the / search syntax." onClick={() => setMode("search")} />
      <Option label="Show a hidden row" sub={hidden.length ? `${hidden.length} hidden` : "Nothing is hidden"} onClick={() => setMode("hidden")} disabled={hidden.length === 0} />
    </>
  );
}

/** The "..." popover on a row: rename, hide, remove. */
function RowMenu({ row, close }: { row: SidebarRowDescriptor; close: () => void }) {
  const updateCategory = useApp((s) => s.updateCategory);
  const deleteCategory = useApp((s) => s.deleteCategory);
  const updateSavedSearch = useApp((s) => s.updateSavedSearch);
  const deleteSavedSearch = useApp((s) => s.deleteSavedSearch);
  const searches = useApp((s) => s.savedSearches);
  const { hide } = useSidebarLayout();
  const [mode, setMode] = useState<RowMode>("menu");
  const [name, setName] = useState(row.label);
  const search = row.kind === "search" ? searches.find((s) => String(s.id) === row.ref) : null;
  const [query, setQuery] = useState(search?.query ?? "");
  const editable = row.kind === "category" || row.kind === "search";

  const rename = async () => {
    if (row.kind === "category" && row.ref) await updateCategory(row.ref, { name: name.trim() });
    if (row.kind === "search" && row.ref && (await updateSavedSearch(Number(row.ref), { name, query })) === false) return;
    close();
  };
  const remove = async () => {
    if (row.kind === "category" && row.ref) await deleteCategory(row.ref);
    if (row.kind === "search" && row.ref) await deleteSavedSearch(Number(row.ref));
    close();
  };

  if (mode === "rename") {
    return (
      <>
        <span className="af-mono">Rename {row.label}</span>
        <Field label="Name" value={name} onChange={setName} placeholder={row.label} autoFocus />
        {row.kind === "search" ? <Field label="Query" value={query} onChange={setQuery} placeholder="northwind invoice" /> : null}
        <Actions submit={row.kind === "search" ? "Save changes" : "Save name"} disabled={!name.trim() || (row.kind === "search" && !query.trim())} onSubmit={() => void rename()} onCancel={close} />
      </>
    );
  }
  if (mode === "remove") {
    return (
      <>
        <span className="af-mono">Remove {row.label}</span>
        <span className="popover-confirm">{row.kind === "category" ? "Removes the category. Threads keep their mail; the Gmail label stays." : "Removes the saved search. Nothing else changes."}</span>
        <Actions submit={row.kind === "category" ? "Remove category" : "Remove saved search"} disabled={false} onSubmit={() => void remove()} onCancel={close} />
      </>
    );
  }
  return (
    <>
      <span className="af-mono">{row.label}</span>
      {editable ? <Option label="Rename" sub={row.kind === "search" ? "Change the name or the query." : "Change the name. The Gmail label keeps its name."} onClick={() => setMode("rename")} /> : null}
      <Option
        label="Hide"
        sub="Takes the row off the sidebar. Show it again from a group's + menu."
        onClick={() => {
          hide(row.id);
          close();
        }}
      />
      {editable ? <Option label="Remove" sub={row.kind === "category" ? "Deletes the category." : "Deletes the saved search."} onClick={() => setMode("remove")} /> : null}
    </>
  );
}

/** Anchored popover for the sidebar's "+" and "..." glyphs. Escape closes it through the key dispatcher; a click outside closes it here. */
export function AddRowPopover() {
  const menu = useApp((s) => s.sidebarMenu);
  const close = useApp((s) => s.closeSidebarMenu);
  const { byId } = useSidebarLayout();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menu, close]);
  if (!menu) return null;
  const style = placement(menu);
  const row = menu.kind === "row" ? byId.get(menu.rowId) : null;
  if (menu.kind === "row" && !row) return null;
  return (
    <div className="sidebar-popover" role="dialog" aria-label={menu.kind === "add" ? "Add a row" : "Row options"} style={style} ref={ref}>
      {menu.kind === "add" ? <AddMenu key={menu.group} group={menu.group} close={close} /> : <RowMenu key={menu.rowId} row={row!} close={close} />}
    </div>
  );
}

function placement(menu: SidebarMenu): { left: number; top: number; width: number } {
  const left = Math.min(menu.anchor.x + 8, Math.max(8, window.innerWidth - WIDTH - 8));
  const top = Math.min(menu.anchor.y, Math.max(8, window.innerHeight - 360));
  return { left, top, width: WIDTH };
}
