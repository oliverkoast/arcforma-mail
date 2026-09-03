// Hand-written types for a package that is deliberately plain JavaScript.
//
// This runs on Cloudflare Workers, where a build step is a liability: the code
// that is reviewed should be the code that is deployed. So there is no tsc here
// and no emitted .d.ts. The cost of that choice is this file, which can drift
// from src/*.mjs. test/types.test.mjs pins the export names against it, so a
// removed or renamed export fails the suite rather than surfacing as a type
// error in a different package.

/** How soon after sending a fetch is the sender's own client or a scanner, not a reader. */
export const PREFETCH_WINDOW_MS: number;

/** What one fetch of the pixel is worth as evidence. */
export type FetchGrade = "opened" | "automatic" | "unknown";

/** What a whole message's fetches are worth. "no signal" is never "unread". */
export type ReceiptStatus = "opened" | "possibly automatic" | "no signal";

export function classifyFetch(fetchEvent: {
  userAgent?: string;
  at: number;
  sentAt: number;
  seenBefore?: boolean;
}): { grade: FetchGrade; why: string };

export function summarise(
  events: ReadonlyArray<{ at: number; grade: string }> | null | undefined,
): { status: ReceiptStatus; firstAt: number | null; count: number };

/** The Worker request handler. Typed loosely: the desktop app never calls it. */
export function createHandler(options?: Record<string, unknown>): (request: Request, env?: unknown) => Promise<Response>;
