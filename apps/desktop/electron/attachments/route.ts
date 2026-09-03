// The app:// route cached attachment bytes are served on. Its own file because
// both the protocol handler in main.ts and the preview window's navigation pin
// need it, and neither should have to import the other.
//
// The URL carries three ids and no path. main.ts resolves them against the
// store, reads the cache row, and confines the resolved file to the attachments
// folder before opening it, so this string can never name a file on disk.

export const ATTACHMENT_ROUTE = "/attachment/";

export function attachmentSrc(accountId: string, messageId: string, key: string): string {
  return `app://mail${ATTACHMENT_ROUTE}${encodeURIComponent(accountId)}/${encodeURIComponent(messageId)}/${encodeURIComponent(key)}`;
}
