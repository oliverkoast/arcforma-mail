// Who the account can send as, ported from draft-sender getOwnerAddresses
// onto raw REST, plus the per-alias signature Gmail already holds.

import type { GmailClient } from "./client.js";

export interface SendAsAlias {
  email: string;
  name: string;
  replyTo: string | null;
  signatureHtml: string | null;
  isPrimary: boolean;
  isDefault: boolean;
  verified: boolean;
}

export interface Owners {
  email: string;
  historyId: string;
  messagesTotal: number;
  /** Primary plus every verified alias, lowercased. */
  addresses: string[];
  sendAs: SendAsAlias[];
  /** Signature of the default send-as address, or the primary's. */
  signatureHtml: string | null;
}

interface ProfileResponse {
  emailAddress: string;
  messagesTotal?: number;
  threadsTotal?: number;
  historyId: string;
}

interface SendAsResponse {
  sendAs?: Array<{
    sendAsEmail?: string;
    displayName?: string;
    replyToAddress?: string;
    signature?: string;
    isPrimary?: boolean;
    isDefault?: boolean;
    verificationStatus?: string;
  }>;
}

export async function getProfile(client: GmailClient): Promise<ProfileResponse> {
  return client.request<ProfileResponse>("profile");
}

export async function getOwners(client: GmailClient): Promise<Owners> {
  const profile = await getProfile(client);
  const sendAsRes = await client.request<SendAsResponse>("settings/sendAs");
  const primary = profile.emailAddress.toLowerCase();
  const addresses = new Set<string>([primary]);
  const sendAs: SendAsAlias[] = [];
  for (const a of sendAsRes.sendAs ?? []) {
    if (!a.sendAsEmail) continue;
    const verified = a.verificationStatus === "accepted" || Boolean(a.isPrimary);
    if (verified) addresses.add(a.sendAsEmail.toLowerCase());
    sendAs.push({
      email: a.sendAsEmail.toLowerCase(),
      name: a.displayName ?? "",
      replyTo: a.replyToAddress || null,
      signatureHtml: a.signature || null,
      isPrimary: Boolean(a.isPrimary),
      isDefault: Boolean(a.isDefault),
      verified,
    });
  }
  const chosen = sendAs.find((s) => s.isDefault) ?? sendAs.find((s) => s.isPrimary) ?? null;
  return {
    email: primary,
    historyId: profile.historyId,
    messagesTotal: profile.messagesTotal ?? 0,
    addresses: Array.from(addresses),
    sendAs,
    signatureHtml: chosen?.signatureHtml ?? null,
  };
}
