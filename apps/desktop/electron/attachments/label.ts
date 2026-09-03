// The main process says byte counts in toasts and window titles, and the
// renderer says them on chips. Same wording both sides, so a toast and the chip
// it came from never disagree; src/lib/format.ts holds the renderer's copy.

export function bytesLabel(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
