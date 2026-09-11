import type { ErrorCode as ErrorCodeValue } from "@koven/domain";
import type { PublicKey } from "@koven/hedera";

import { domainSeparatedBytes } from "./canonical.js";

export class CreditProtocolError extends Error {
  constructor(readonly code: ErrorCodeValue, message: string) {
    super(message);
    this.name = "CreditProtocolError";
  }
}

export function assertCredit(
  condition: unknown,
  code: ErrorCodeValue,
  message: string,
): asserts condition {
  if (!condition) throw new CreditProtocolError(code, message);
}

export function verifyCanonicalSignature(
  publicKey: PublicKey,
  domain: string,
  payload: unknown,
  signature: string,
): boolean {
  if (!/^[0-9a-f]{128}$/.test(signature)) return false;
  try {
    return publicKey.verify(
      domainSeparatedBytes(domain, payload),
      Uint8Array.from(Buffer.from(signature, "hex")),
    );
  } catch {
    return false;
  }
}
