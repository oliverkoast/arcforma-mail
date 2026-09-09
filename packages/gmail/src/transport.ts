// Every network call in this package goes through a Transport so tests can
// replay fixtures. The default is the global fetch.

export interface TransportResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface TransportInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type Transport = (url: string, init: TransportInit) => Promise<TransportResponse>;

export const REQUEST_TIMEOUT_MS = 30_000;

/** Bound headers AND body reads so a lost connection cannot hold a sync run open. */
export function createFetchTransport(timeoutMs = REQUEST_TIMEOUT_MS): Transport {
  return async (url, init) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    const response = await fetch(url, { ...init, signal });
    const body = await response.text();
    return { status: response.status, headers: response.headers, text: async () => body };
  };
}

export const fetchTransport: Transport = createFetchTransport();

export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
