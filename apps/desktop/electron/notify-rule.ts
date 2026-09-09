/**
 * Whether one message earns a banner. Pure, so the rule is tested without Electron.
 *
 * A banner is for mail a person would want interrupted for: what the classifier called important,
 * and calendar mail, which is usually someone else's time. Nothing from before the app started is
 * announced, however new it is to the store: replaying a morning's mail as banners at launch is
 * noise, not news. Each message is announced once.
 */
export interface BannerCandidate {
  enabled: boolean;
  smoke: boolean;
  split: string | null;
  type: string | null;
  direction: "in" | "out";
  internalDate: number;
  startedAt: number;
  seen: boolean;
}

export function shouldBanner(c: BannerCandidate): boolean {
  if (!c.enabled || c.smoke || c.seen) return false;
  if (c.direction !== "in") return false;
  if (c.internalDate < c.startedAt) return false;
  return c.split === "important" || c.type === "calendar";
}
