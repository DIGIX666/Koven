import { createHash } from "node:crypto";

export const hashBytes = (value: string | Uint8Array): string => createHash("sha256")
  .update(value)
  .digest("hex");

export const hashBase64 = (value: string): string => hashBytes(Buffer.from(value, "base64"));

export const canonicalJsonValue = (value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString(10);
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalJsonValue(nested)]),
    );
  }
  return value;
};

export const hashCanonicalJson = (value: unknown): string => createHash("sha256")
  .update(JSON.stringify(canonicalJsonValue(value)))
  .digest("hex");
