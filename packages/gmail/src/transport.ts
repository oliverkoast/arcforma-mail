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

export const fetchTransport: Transport = (url, init) => fetch(url, init);

export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
