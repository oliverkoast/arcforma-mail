/** Reconnect is a hint to retry now; regular polling still covers missed events. */
export function installNetworkRecovery(target: EventTarget, retry: () => Promise<unknown>): () => void {
  const online = () => { void retry().catch(() => undefined); };
  target.addEventListener("online", online);
  return () => target.removeEventListener("online", online);
}

/** Retry missing message content without overlapping slow requests. */
export function retryMissingContent(retry: () => Promise<unknown>, delay = 30_000): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const run = async () => {
    try { await retry(); } catch { /* Keep trying after a transient failure. */ }
    if (!stopped) timer = setTimeout(() => void run(), delay);
  };
  timer = setTimeout(() => void run(), delay);
  return () => { stopped = true; clearTimeout(timer); };
}
