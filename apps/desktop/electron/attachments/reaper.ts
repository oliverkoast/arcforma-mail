// Unlinks cached attachment files whose message has gone.
//
// The store cannot delete files, so when a message (or its thread, or its
// account) goes, its attachment_files rows move to orphan_attachments and the
// paths wait there. This drains that queue: on start, and then on a slow timer,
// so mail archived or trashed during a session does not leave its attachments
// on disk until the next launch.
//
// Every path is checked against the attachments root before the unlink. A path
// that escapes is left alone and counted, never removed: the queue is data in a
// file on disk, and a tampered row must not be able to delete anything outside
// the folder this feature owns.

import { drainOrphanAttachments, type Db } from "@arcforma/store";
import { unlinkOrphans } from "./cache.js";
import { log } from "../log.js";

const SWEEP_MS = 10 * 60_000;
/** Paths per sweep. A big archive run queues many; they drain over the next few sweeps rather than in one stall. */
const BATCH = 200;

export class AttachmentReaper {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Db,
    private readonly root: string
  ) {}

  start(): void {
    if (this.timer) return;
    this.sweep();
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Drains one batch. Returns what it removed, so a test can drive it without a timer. */
  sweep(): { removed: number; refused: number } {
    const paths = drainOrphanAttachments(this.db, BATCH);
    if (paths.length === 0) return { removed: 0, refused: 0 };
    const result = unlinkOrphans(this.root, paths);
    if (result.removed) log("attachments", `removed ${result.removed} cached file(s) whose message is gone`);
    if (result.refused) log("attachments", `refused ${result.refused} cached path(s) that resolved outside the attachments folder`);
    return result;
  }
}
