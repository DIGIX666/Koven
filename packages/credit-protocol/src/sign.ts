import type { PrivateKey } from "@koven/hedera";

import { domainSeparatedBytes } from "./canonical.js";

export const bytesToHex = (value: Uint8Array): string => Buffer.from(value).toString("hex");

/** Produces the frozen lowercase 64-byte ECDSA signature representation. */
export function signCanonicalPayload(
  privateKey: PrivateKey,
  domain: string,
  payload: unknown,
): string {
  const signature = bytesToHex(privateKey.sign(domainSeparatedBytes(domain, payload)));
  if (!/^[0-9a-f]{128}$/.test(signature)) {
    throw new Error("Expected a 64-byte Hedera signature");
  }
  return signature;
}
