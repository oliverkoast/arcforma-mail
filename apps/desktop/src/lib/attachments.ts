// Whether a message has files, and how sure we are of the number.
//
// Two sources disagree by design. The message list carries a hasAttachments flag from Gmail's
// metadata, which is available immediately but is only a yes or no, and counts inline images that
// are part of the layout rather than files anyone would open. The loaded body carries the real
// parts, and is the only thing that can be counted, but it does not arrive until the message opens.
//
// Saying "there are files" a moment before knowing how many beats saying nothing until the body
// lands, because the whole point of the marker is to be seen at the top of a message that may run
// for two screens before the chips appear underneath it.

import type { MessageView } from "../../shared/types";

export interface AttachmentMarker {
  /** How many files to claim. Never zero when there is anything to show. */
  count: number;
  /** True when count came from the loaded body, so it is safe to print as a number. */
  exact: boolean;
}

export function attachmentMarker(message: Pick<MessageView, "body" | "hasAttachments">): AttachmentMarker {
  if (message.body) {
    // Inline images are part of the message's layout, not files. Counting them would promise a
    // paperclip and then show chips that are not there.
    return { count: message.body.attachments.filter((a) => !a.inline).length, exact: true };
  }
  return { count: message.hasAttachments ? 1 : 0, exact: false };
}
