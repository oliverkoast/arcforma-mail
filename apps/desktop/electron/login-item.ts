// Whether this process may touch the macOS Login Items list. Only a packed
// app on macOS, and never a smoke run: a dev or smoke process would register
// the bare Electron binary as a login item. Pure so node:test can check it.

export interface LoginItemEnvironment {
  isPackaged: boolean;
  platform: NodeJS.Platform | string;
  /** ARCMAIL_SMOKE, set by scripts/smoke.mjs. */
  smoke: string | undefined;
}

export function loginItemAllowed(env: LoginItemEnvironment): boolean {
  return env.isPackaged && !env.smoke && env.platform === "darwin";
}
