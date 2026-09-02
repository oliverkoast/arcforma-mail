import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Transport, TransportInit, TransportResponse } from "../src/transport.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): string {
  return fs.readFileSync(path.join(here, "fixtures", name), "utf8");
}

export function fixtureJson<T = unknown>(name: string): T {
  return JSON.parse(fixture(name)) as T;
}

export interface Canned {
  status: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export interface Call {
  url: string;
  init: TransportInit;
}

/** A transport that replays canned responses in order and records every call. */
export function fakeTransport(responses: Canned[] | ((call: Call, index: number) => Canned)): { transport: Transport; calls: Call[] } {
  const calls: Call[] = [];
  const transport: Transport = async (url, init) => {
    const index = calls.length;
    calls.push({ url, init });
    const canned = typeof responses === "function" ? responses({ url, init }, index) : responses[index];
    if (!canned) throw new Error(`no canned response for call ${index}: ${url}`);
    const headers = new Map(Object.entries(canned.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const res: TransportResponse = {
      status: canned.status,
      headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
      text: async () => canned.text ?? (canned.body === undefined ? "" : JSON.stringify(canned.body)),
    };
    return res;
  };
  return { transport, calls };
}

export function fakeClock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

export const token = async () => "test-token";
