// The pure half of the tooltip layer: where a card goes, whether a row's text
// is cut off, and the text for the rows that describe themselves at hover
// time. Nothing here touches the DOM, so node:test drives it directly.

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Placement {
  left: number;
  top: number;
  /** True when the card sits above the element because there was no room below. */
  above: boolean;
}

/** The pointer rests this long on one element before the card shows. */
export const TIP_DELAY_MS = 700;
/** Space between the element and the card. */
export const TIP_GAP = 6;
/** The card never comes closer than this to the viewport edge. */
export const TIP_MARGIN = 8;

/**
 * Below the element, centred on it, by default. Above it when the card would
 * run off the bottom and there is room on top. When neither side has room the
 * side with more room wins and the card is clamped inside the viewport.
 * Horizontally the card is always clamped inside the viewport.
 */
export function placeTooltip(anchor: Box, tip: Size, viewport: Size, gap = TIP_GAP, margin = TIP_MARGIN): Placement {
  const belowTop = anchor.top + anchor.height + gap;
  const aboveTop = anchor.top - gap - tip.height;
  const fitsBelow = belowTop + tip.height <= viewport.height - margin;
  const fitsAbove = aboveTop >= margin;
  let above: boolean;
  if (fitsBelow) above = false;
  else if (fitsAbove) above = true;
  else above = anchor.top > viewport.height - (anchor.top + anchor.height);
  let top = above ? aboveTop : belowTop;
  top = Math.max(margin, Math.min(top, viewport.height - margin - tip.height));
  const centred = anchor.left + anchor.width / 2 - tip.width / 2;
  const left = Math.max(margin, Math.min(centred, viewport.width - margin - tip.width));
  return { left, top, above };
}

export interface Measured {
  scrollWidth: number;
  clientWidth: number;
}

/** True when any of the measured elements has text cut off by its box. */
export function anyTruncated(els: ReadonlyArray<Measured>): boolean {
  return els.some((el) => el.scrollWidth > el.clientWidth);
}

/** The first n characters of a snippet, cut at a word and marked with an ellipsis when shorter than the whole. */
export function clip(text: string, n: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const at = cut.lastIndexOf(" ");
  return `${at > n / 2 ? cut.slice(0, at) : cut}…`;
}

/** What a thread row says when its subject or snippet is cut off: the full subject, the start of the snippet, the account. */
export function threadRowTip(subject: string, snippet: string, account: string | null): string {
  const lines = [subject.trim() || "(no subject)"];
  const s = clip(snippet, 140);
  if (s) lines.push(s);
  if (account) lines.push(account);
  return lines.join("\n");
}

export interface EventLike {
  summary: string;
  startAt: number;
  endAt: number;
  allDay: boolean;
  attendees: ReadonlyArray<{ email: string; name: string | null; self: boolean }>;
}

/** A calendar event in full: title, when, and who is invited. */
export function calendarEventTip(ev: EventLike, format: (t: number) => string = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })): string {
  const when = ev.allDay ? "All day" : `${format(ev.startAt)} to ${format(ev.endAt)}`;
  const others = ev.attendees.filter((a) => !a.self).map((a) => a.name || a.email);
  const lines = [ev.summary.trim() || "(no title)", when];
  if (others.length) lines.push(`With ${others.join(", ")}`);
  return lines.join("\n");
}
