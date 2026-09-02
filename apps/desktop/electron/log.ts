export function log(scope: string, message: string, data?: unknown): void {
  const stamp = new Date().toISOString();
  if (data === undefined) console.log(`${stamp} [${scope}] ${message}`);
  else console.log(`${stamp} [${scope}] ${message}`, typeof data === "string" ? data : JSON.stringify(data));
}

export function logError(scope: string, message: string, err: unknown): void {
  const stamp = new Date().toISOString();
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(`${stamp} [${scope}] ${message}: ${detail}`);
}
