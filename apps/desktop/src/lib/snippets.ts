// Snippet trigger detection and variable expansion. `;trigger` immediately
// before the cursor, typed after whitespace or at the start of a block,
// expands on Space or Tab. The body may carry variables in braces:
//
//   {first_name} {last_name} {name} {email} {company}   the first To recipient
//   {my_name} {my_first_name}                            the sending account
//   {today} {tomorrow} {next_monday}                     "Tuesday, September 8"
//   {cursor}                                             where the caret lands
//
// Unknown variables stay as typed. Recipient variables with no recipient yet
// become empty and are reported in `missing` so the compose can say so.

export interface SnippetLike {
  trigger: string;
  bodyHtml: string;
  bodyText: string;
}

export interface TriggerMatch<S extends SnippetLike> {
  snippet: S;
  /** Characters to delete before the cursor, including the semicolon. */
  length: number;
}

const TRIGGER = /(^|\s);([a-z0-9_-]{1,32})$/i;

/** Looks at the text before the cursor and finds a snippet whose trigger was just typed. */
export function findTrigger<S extends SnippetLike>(textBefore: string, snippets: S[]): TriggerMatch<S> | null {
  const m = TRIGGER.exec(textBefore);
  if (!m) return null;
  const word = m[2]!.toLowerCase();
  const snippet = snippets.find((s) => s.trigger.toLowerCase() === word);
  if (!snippet) return null;
  return { snippet, length: word.length + 1 };
}

/** Case-insensitive filter for the picker: trigger or name contains the query. */
export function filterSnippets<S extends SnippetLike & { name: string }>(query: string, snippets: S[]): S[] {
  const q = query.trim().replace(/^;/, "").toLowerCase();
  if (!q) return snippets;
  return snippets.filter((s) => s.trigger.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
}

// ---- variables ------------------------------------------------------------------

export interface SnippetRecipient {
  email: string;
  name: string;
}

export interface SnippetContext {
  /** The first To recipient, or null while the line is empty. */
  recipient: SnippetRecipient | null;
  /** The recipient's stored company when the contact rail knows one; the domain is the fallback. */
  company?: string | null;
  /** The sending account. */
  account: { email: string; displayName: string | null } | null;
  /** Local "now" for the date variables; tests pin it. */
  now?: Date;
}

export interface ExpandedSnippet {
  html: string;
  text: string;
  /** Variables that resolved to nothing: the recipient is missing, or has no last name, or the account has no name. */
  missing: string[];
  /** True when the body carried {cursor}; the editor puts the caret on the CURSOR_TOKEN it left behind. */
  hasCursor: boolean;
}

/** A private-use character standing in for {cursor} after expansion; the editor removes it and places the caret there. */
export const CURSOR_TOKEN = "\uE002";

export const SNIPPET_VARIABLES = ["first_name", "last_name", "name", "email", "company", "my_name", "my_first_name", "today", "tomorrow", "next_monday", "cursor"] as const;
export type SnippetVariable = (typeof SNIPPET_VARIABLES)[number];

const VARIABLE = /\{([a-z_]+)\}/g;

/** Domains whose second-level label is a mail provider, not the recipient's company. */
const FREEMAIL = new Set(["gmail", "googlemail", "yahoo", "hotmail", "outlook", "live", "icloud", "me", "mac", "aol", "proton", "protonmail", "pm", "gmx", "mail", "fastmail", "hey", "msn", "ymail", "zoho"]);

function capitalise(word: string): string {
  return word ? word[0]!.toUpperCase() + word.slice(1) : "";
}

/** "northwind-coaching.example" becomes "Northwind Coaching"; a mail provider becomes null. */
export function companyFromDomain(email: string): string | null {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (!domain) return null;
  const labels = domain.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  // The registrable label: the one before a public suffix, allowing for co.uk style two-part suffixes.
  const idx = labels.length >= 3 && labels[labels.length - 2]!.length <= 3 && labels[labels.length - 1]!.length <= 3 ? labels.length - 3 : labels.length - 2;
  const label = labels[idx] ?? "";
  if (!label || FREEMAIL.has(label)) return null;
  return label
    .split(/[-_.]+/)
    .filter(Boolean)
    .map(capitalise)
    .join(" ");
}

/** "Dana Reyes" or, failing a name, "dana.reyes" from the address: first and last words. */
export function splitName(recipient: SnippetRecipient): { first: string; last: string; full: string } {
  const name = recipient.name.trim().replace(/^"|"$/g, "");
  if (name) {
    const parts = name.split(/\s+/);
    return { first: parts[0] ?? "", last: parts.length > 1 ? parts[parts.length - 1]! : "", full: name };
  }
  const local = recipient.email.split("@")[0] ?? "";
  const parts = local
    .split(/[._-]+/)
    .filter((p) => p && !/^\d+$/.test(p))
    .map((p) => capitalise(p.toLowerCase()));
  return { first: parts[0] ?? "", last: parts.length > 1 ? parts[parts.length - 1]! : "", full: parts.join(" ") };
}

/** "Tuesday, September 8": the long weekday and month, no year, in the machine's local time. */
export function formatLongDate(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

/** The Monday after today. On a Monday that is next week's. */
export function nextMonday(d: Date): Date {
  const day = d.getDay();
  return addDays(d, day === 0 ? 1 : 8 - day);
}

/**
 * The value of one variable. Returns a string when it resolved, null when
 * the variable is known but nothing is there to fill it, and undefined for a
 * name the syntax does not know.
 */
export function resolveVariable(name: string, ctx: SnippetContext): string | null | undefined {
  const now = ctx.now ?? new Date();
  const r = ctx.recipient;
  switch (name) {
    case "first_name":
      return r ? splitName(r).first || null : null;
    case "last_name":
      return r ? splitName(r).last || null : null;
    case "name":
      return r ? splitName(r).full || null : null;
    case "email":
      return r ? r.email || null : null;
    case "company": {
      const stored = ctx.company?.trim();
      if (stored) return stored;
      return r ? companyFromDomain(r.email) : null;
    }
    case "my_name": {
      const n = ctx.account?.displayName?.trim();
      return n || null;
    }
    case "my_first_name": {
      const n = ctx.account?.displayName?.trim();
      return n ? n.split(/\s+/)[0] ?? null : null;
    }
    case "today":
      return formatLongDate(now);
    case "tomorrow":
      return formatLongDate(addDays(now, 1));
    case "next_monday":
      return formatLongDate(nextMonday(now));
    case "cursor":
      return CURSOR_TOKEN;
    default:
      return undefined;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function expandText(body: string, ctx: SnippetContext, missing: Set<string>, html: boolean): string {
  return body.replace(VARIABLE, (whole, name: string) => {
    const value = resolveVariable(name, ctx);
    if (value === undefined) return whole;
    if (value === null) {
      missing.add(name);
      return "";
    }
    return html && name !== "cursor" ? escapeHtml(value) : value;
  });
}

/** Fills the variables in both bodies. The html body keeps its markup; values are escaped into it. */
export function expandSnippet(snippet: Pick<SnippetLike, "bodyHtml" | "bodyText">, ctx: SnippetContext): ExpandedSnippet {
  const missing = new Set<string>();
  const html = expandText(snippet.bodyHtml, ctx, missing, true);
  const text = expandText(snippet.bodyText, ctx, missing, false);
  const hasCursor = /\{cursor\}/.test(snippet.bodyHtml) || /\{cursor\}/.test(snippet.bodyText);
  return { html, text, missing: Array.from(missing), hasCursor };
}

/** The toast line for variables that came up empty, or null when none did. */
export function missingVariablesText(missing: string[]): string | null {
  if (missing.length === 0) return null;
  const names = missing.map((m) => `{${m}}`).join(", ");
  const recipient = missing.some((m) => m === "first_name" || m === "last_name" || m === "name" || m === "email" || m === "company");
  return recipient ? `Add a recipient to fill ${names}.` : `Nothing to fill ${names} with.`;
}

/** Removes the caret marker for callers that cannot place the caret (a plain insert, a preview). */
export function stripCursorToken(s: string): string {
  return s.split(CURSOR_TOKEN).join("");
}
