import { createHash } from "node:crypto";

import type { PrivateKey, PublicKey } from "@koven/hedera";

/**
 * Canonical JSON frozen in docs/protocol.md: ASCII-sorted keys, compact
 * JSON.stringify escaping, bigint as decimal strings, absent optional
 * properties omitted, undefined array entries and non-finite or non-safe
 * numbers rejected. Signatures and hashes are computed over exactly this.
 */
function canonicalValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not support non-finite numbers");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError("Canonical JSON does not support unsafe integer numbers");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      if (!(index in value) || entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
        throw new TypeError("Canonical JSON does not support omitted array entries");
      }
      return canonicalValue(entry);
    });
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalValue(value));
  if (serialized === undefined) throw new TypeError("Value cannot be represented as canonical JSON");
  return serialized;
}

export const sha256Hex = (value: string | Uint8Array): string => (
  createHash("sha256").update(value).digest("hex")
);

export const canonicalHash = (value: unknown): string => sha256Hex(Buffer.from(canonicalJson(value), "utf8"));

export const SCAN_AUTHORIZATION_DOMAIN = "koven:scan-payment-authorization:v1";

const domainBytes = (domain: string, payload: unknown): Buffer => (
  Buffer.from(`${domain}\n${canonicalJson(payload)}`, "utf8")
);

/** Lowercase hex of the 64-byte secp256k1 `r || s` signature produced by the Hedera SDK. */
export function signDomain(privateKey: PrivateKey, domain: string, payload: unknown): string {
  const signature = Buffer.from(privateKey.sign(domainBytes(domain, payload))).toString("hex");
  if (!/^[0-9a-f]{128}$/.test(signature)) throw new Error("Expected a 64-byte ECDSA signature");
  return signature;
}

export function verifyDomain(publicKey: PublicKey, domain: string, payload: unknown, signature: string): boolean {
  if (!/^[0-9a-f]{128}$/.test(signature)) return false;
  try {
    return publicKey.verify(domainBytes(domain, payload), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

/** Removes the transport `signature` field before hashing or verifying. */
export function withoutSignature<T extends { signature?: unknown }>(value: T): Omit<T, "signature"> {
  const { signature: _signature, ...unsigned } = value;
  return unsigned;
}
