// Arming one message: what the send path needs from the pixel service, behind
// a small interface so the queue can be tested without a network.
//
// Arming is best effort by design. A service that is down, misconfigured, or
// slow costs the sender a receipt and nothing else: the message still goes.

import type { Db } from "@arcforma/store";
import { pixelImg } from "./pixel.js";
import { receiptConfig, receiptsUsable, type ReceiptService } from "./service.js";

export interface ReceiptArmer {
  /** True when receipts are on, a service URL is set, and a token is stored. */
  usable(): boolean;
  /** Why a receipt cannot be armed at all, in words for a toast. Only asked when usable() is false. */
  unavailable(): string;
  /** Tells the service the message is going out. Throws when it does not take. */
  register(token: string, sentAt: number): Promise<void>;
  /** The image tag for the token, on the configured service. */
  pixelHtml(token: string): string;
}

export function serviceArmer(db: Db, service: ReceiptService): ReceiptArmer {
  return {
    usable: () => receiptsUsable(db),
    unavailable() {
      const c = receiptConfig(db);
      if (!c.enabled) return "read receipts are switched off in Settings";
      if (!c.url) return "no pixel service is set up yet; see packages/pixel-service/README.md";
      return "no pixel service token is stored";
    },
    register: (token, sentAt) => service.register(token, sentAt),
    pixelHtml: (token) => pixelImg(receiptConfig(db).url, token),
  };
}
