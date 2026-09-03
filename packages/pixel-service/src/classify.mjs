/**
 * What an image fetch actually tells you.
 *
 * A tracking pixel does not report that a person read a message. It reports that something asked
 * for an image. Mail providers, security scanners and privacy proxies all ask for images without a
 * human involved, so the honest output of this service is a graded signal, never a certainty.
 *
 * The grades:
 *   opened      a fetch that looks like a mail client rendering for a person
 *   automatic   a fetch a machine almost certainly made: a privacy proxy, a scanner, a prefetch
 *   unknown     a fetch we cannot place
 * A message with no fetch at all is not "unread": it is "no signal", because the recipient may
 * simply block images. Callers must not collapse those two.
 */

/** Apple relays every image through its own proxy the moment a message arrives, read or not. */
const APPLE_PROXY = /\bAppleMailProxy\b|\biOS Mail Proxy\b/i;
const APPLE_PROXY_UA = /Mozilla\/5\.0 \(Macintosh; Intel Mac OS X 10_15_7\) AppleWebKit\/605\.1\.15/;

/** Google proxies images for Gmail. A fetch through it means Gmail rendered the message. */
const GOOGLE_PROXY = /GoogleImageProxy|via ggpht\.com|googleusercontent/i;

/** Scanners and link checkers that open everything in a mailbox as a matter of policy. */
const SCANNER = /(bot|crawler|spider|scanner|preview|validator|monitor|proofpoint|mimecast|barracuda|symantec|forcepoint|slackbot|curl|wget|python-requests|okhttp|java\/|libwww|headless)/i;

/** A fetch this soon after sending is the sender's own client or a scanner, not a reader. */
export const PREFETCH_WINDOW_MS = 20_000;

/**
 * @param {{userAgent?: string, at: number, sentAt: number, seenBefore?: boolean}} fetchEvent
 * @returns {{grade: "opened"|"automatic"|"unknown", why: string}}
 */
export function classifyFetch({ userAgent = "", at, sentAt, seenBefore = false }) {
  const ua = String(userAgent);
  if (at - sentAt < PREFETCH_WINDOW_MS && !seenBefore) {
    return { grade: "automatic", why: "fetched within seconds of sending, which is a scanner or your own client" };
  }
  if (APPLE_PROXY.test(ua) || (APPLE_PROXY_UA.test(ua) && !GOOGLE_PROXY.test(ua))) {
    return { grade: "automatic", why: "Apple Mail Privacy Protection loads images whether or not anyone looks" };
  }
  if (SCANNER.test(ua)) return { grade: "automatic", why: "a scanner or a link checker, not a mail client" };
  if (GOOGLE_PROXY.test(ua)) return { grade: "opened", why: "Gmail rendered the message" };
  if (!ua.trim()) return { grade: "unknown", why: "no client identified itself" };
  return { grade: "opened", why: "a mail client rendered the message" };
}

/**
 * Roll every fetch for one message into the one line a person should see.
 * @param {Array<{at: number, grade: string}>} events
 * @returns {{status: "opened"|"possibly automatic"|"no signal", firstAt: number|null, count: number}}
 */
export function summarise(events) {
  if (!events || events.length === 0) return { status: "no signal", firstAt: null, count: 0 };
  const human = events.filter((e) => e.grade === "opened").sort((a, b) => a.at - b.at);
  if (human.length > 0) return { status: "opened", firstAt: human[0].at, count: human.length };
  const sorted = [...events].sort((a, b) => a.at - b.at);
  return { status: "possibly automatic", firstAt: sorted[0].at, count: sorted.length };
}
