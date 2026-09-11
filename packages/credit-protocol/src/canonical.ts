import { createHash } from "node:crypto";

const canonicalValue = (value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON does not support non-finite numbers");
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError("Canonical JSON does not support unsafe integer numbers");
    }
  }
  if (Array.isArray(value)) {
    return value.map((nested, index) => {
      if (!(index in value) || nested === undefined
        || typeof nested === "function" || typeof nested === "symbol") {
        throw new TypeError("Canonical JSON does not support omitted array entries");
      }
      return canonicalValue(nested);
    });
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== undefined)
        .sort()
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  }
  return value;
};

/** Serializes contract payloads with ASCII-sorted keys and decimal bigint values. */
export const canonicalJson = (value: unknown): string => {
  const serialized = JSON.stringify(canonicalValue(value));
  if (serialized === undefined) throw new TypeError("Value cannot be represented as canonical JSON");
  return serialized;
};

export const canonicalHash = (value: unknown): string => createHash("sha256")
  .update(canonicalJson(value), "utf8")
  .digest("hex");

export const domainSeparatedBytes = (domain: string, value: unknown): Uint8Array => (
  new TextEncoder().encode(`${domain}\n${canonicalJson(value)}`)
);

/** Signature fields are transport metadata and never sign themselves. */
export const withoutSignature = <T extends object>(value: T): Omit<T, "signature"> => {
  const { signature: _signature, ...unsigned } = value as T & { signature?: unknown };
  return unsigned;
};
