export class GmailApiError extends Error {
  status: number;
  reason: string | null;
  retryAfterMs: number | null;
  constructor(status: number, message: string, reason: string | null = null, retryAfterMs: number | null = null) {
    super(message);
    this.name = "GmailApiError";
    this.status = status;
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The refresh token no longer works (invalid_grant). The account needs a fresh sign-in. */
export class AuthExpiredError extends Error {
  constructor(message = "Sign in again to keep this account connected.") {
    super(message);
    this.name = "AuthExpiredError";
  }
}

/** history.list returned 404: the watermark is too old and a backfill is needed. */
export class HistoryExpiredError extends Error {
  constructor(message = "History watermark expired.") {
    super(message);
    this.name = "HistoryExpiredError";
  }
}

export class OAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthConfigError";
  }
}

export function isRateLimit(status: number, reason: string | null): boolean {
  if (status === 429) return true;
  return status === 403 && (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded");
}

export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}
