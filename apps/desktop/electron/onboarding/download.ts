// Downloading the local model into ~/Library/Application Support/Arcforma/models.
//
// One file at a time, into <name>.part, renamed only when the whole thing is
// there and the byte count matches what the server said. A run that stops
// (cancelled, a dropped connection, a quit) leaves the .part behind, and the
// next start asks for the rest with a Range header when the server allows it,
// so nobody pays for the first two gigabytes twice.

import fs from "node:fs";
import path from "node:path";
import type { DownloadState } from "../../shared/onboarding.js";

export interface DownloadResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | null;
}

export type DownloadFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<DownloadResponse>;

export interface ModelDownloadOptions {
  url: string;
  /** Where the finished file goes. The .part file sits next to it. */
  dest: string;
  /** The size the catalog claims, shown before the download starts and checked at the end. */
  expectedBytes: number | null;
  fetchImpl: DownloadFetch;
  onProgress?: (state: DownloadState) => void;
}

const IDLE: DownloadState = { phase: "idle", received: 0, total: null, resumed: false, file: null, error: null };

/**
 * One download, start to finish. Every transition goes through `emit`, so the
 * renderer sees exactly the states the tests assert on.
 */
export class ModelDownload {
  private state: DownloadState = { ...IDLE };
  private controller: AbortController | null = null;
  private running: Promise<DownloadState> | null = null;

  constructor(private readonly opts: ModelDownloadOptions) {}

  get partFile(): string {
    return `${this.opts.dest}.part`;
  }

  current(): DownloadState {
    return { ...this.state };
  }

  private emit(patch: Partial<DownloadState>): DownloadState {
    this.state = { ...this.state, ...patch };
    this.opts.onProgress?.(this.current());
    return this.current();
  }

  /** Bytes already on disk from an earlier run, or 0. */
  partialBytes(): number {
    try {
      return fs.statSync(this.partFile).size;
    } catch {
      return 0;
    }
  }

  /** Starts, or hands back the run already in flight. Never starts two. */
  start(): Promise<DownloadState> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = null;
      this.controller = null;
    });
    return this.running;
  }

  cancel(): DownloadState {
    if (this.controller) this.controller.abort();
    return this.current();
  }

  private async run(): Promise<DownloadState> {
    const controller = new AbortController();
    this.controller = controller;
    const from = this.partialBytes();
    this.emit({ phase: "starting", received: from, total: this.opts.expectedBytes, resumed: from > 0, file: null, error: null });
    fs.mkdirSync(path.dirname(this.opts.dest), { recursive: true });

    let res: DownloadResponse;
    try {
      const headers: Record<string, string> = { accept: "application/octet-stream" };
      if (from > 0) headers["range"] = `bytes=${from}-`;
      res = await this.opts.fetchImpl(this.opts.url, { headers, signal: controller.signal });
    } catch (err) {
      return this.stopped(controller, `The download could not start: ${(err as Error).message}`);
    }

    // 206 continues the part file; 200 means the server ignored the range and is sending the whole file again.
    let received = from;
    let append = res.status === 206;
    if (res.status === 200) {
      received = 0;
      append = false;
    } else if (res.status !== 206) {
      return this.stopped(controller, `The server answered ${res.status} instead of sending the file. Try again later.`);
    }
    if (!res.body) return this.stopped(controller, "The server sent no data.");

    const declared = Number(res.headers.get("content-length"));
    const total = Number.isFinite(declared) && declared > 0 ? received + declared : this.opts.expectedBytes;
    this.emit({ phase: "downloading", received, total, resumed: append });

    const handle = fs.openSync(this.partFile, append ? "a" : "w");
    try {
      for await (const chunk of res.body) {
        if (controller.signal.aborted) break;
        fs.writeSync(handle, chunk);
        received += chunk.byteLength;
        this.emit({ received });
      }
    } catch (err) {
      fs.closeSync(handle);
      if (controller.signal.aborted) return this.stopped(controller, null);
      return this.stopped(controller, `The download stopped after ${received} bytes: ${(err as Error).message}. Start it again to pick up where it left off.`);
    }
    fs.closeSync(handle);
    if (controller.signal.aborted) return this.stopped(controller, null);

    const onDisk = this.partialBytes();
    if (total !== null && onDisk !== total) {
      return this.stopped(controller, `The file arrived at ${onDisk} bytes instead of ${total}. Nothing was installed. Start it again to fetch the rest.`);
    }
    fs.renameSync(this.partFile, this.opts.dest);
    this.controller = null;
    return this.emit({ phase: "done", received: onDisk, total, file: this.opts.dest, error: null });
  }

  /** One exit for every failure and for the cancel: an aborted run is cancelled, never failed. */
  private stopped(controller: AbortController, error: string | null): DownloadState {
    this.controller = null;
    if (controller.signal.aborted) return this.emit({ phase: "cancelled", error: null });
    return this.emit({ phase: "failed", error });
  }
}
