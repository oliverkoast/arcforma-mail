import type { SettingsInfo } from "../../shared/types";

/** The inbox split the app opens on. A setting rather than a constant: some people live in Important. */
export function startingSplit(settings: Pick<SettingsInfo, "startSplit">): "important" | null {
  return settings.startSplit === "important" ? "important" : null;
}
