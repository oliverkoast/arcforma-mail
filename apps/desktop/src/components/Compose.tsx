import { useApp } from "../state/store";
import { ComposeEditor, MODE_LABEL } from "./ComposeEditor";
import { ComposeFooter } from "./ComposeFooter";
import { RecipientLine } from "./RecipientLine";
import { hint } from "./IconButton";

export { insertComposeText } from "./ComposeEditor";

/** The floating compose panel: C for a new message, and any draft that has no open thread to dock under. */
export function Compose() {
  const compose = useApp((s) => s.compose);
  const placement = useApp((s) => s.composePlacement);
  const accounts = useApp((s) => s.status.accounts);
  const closeCompose = useApp((s) => s.closeCompose);

  if (!compose || placement !== "panel") return null;
  const account = accounts.find((a) => a.id === compose.accountId);

  return (
    <section className="compose" role="dialog" aria-label={MODE_LABEL[compose.mode]}>
      <div className="compose-head">
        <span className="af-mono">
          {MODE_LABEL[compose.mode]} · {account?.email ?? compose.accountId}
        </span>
        <button className="compose-close" data-tip="Close the panel. The draft is kept under Drafts and in Gmail." data-key={hint("closeCompose")} onClick={() => void closeCompose(true)}>
          Close and keep draft (Esc)
        </button>
      </div>
      <RecipientLine compose={compose} startExpanded />
      <label className="compose-field">
        <span className="af-mono">Subject</span>
        <input value={compose.subject} onChange={(e) => useApp.getState().updateCompose({ subject: e.target.value })} spellCheck={false} data-tip="The subject line." />
      </label>
      <ComposeEditor compose={compose} autofocus={compose.to.length > 0} />
      <ComposeFooter />
    </section>
  );
}
