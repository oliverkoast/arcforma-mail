import { contactStats, getSetting, type Db } from "@arcforma/store";
import type { MessageRow } from "@arcforma/store";

/**
 * Remote images: a per-sender choice wins; otherwise the setting decides. "known" means the
 * sender is you or someone you have replied to at least once, so newsletters and cold mail stay
 * blocked while real correspondence renders. Always https only, inside the sandboxed frame.
 */
export function shouldLoadImages(db: Db, m: Pick<MessageRow, "from_email" | "direction">, perSender: number | null): boolean {
  if (perSender === 1) return true;
  if (perSender === -1) return false;
  const mode = getSetting(db, "remoteImages");
  if (mode === "never") return false;
  if (mode === "always") return true;
  if (m.direction === "out") return true;
  return contactStats(db, m.from_email).twoWayThreads > 0;
}
