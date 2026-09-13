import { createHash } from "node:crypto";

// Node-only entry point (`@koven/audit/node`): the Hedera publisher and payload
// hashing. Kept out of the root entry so browser bundles of `@koven/schemas`
// never pull `node:crypto` or the Hedera SDK.
export * from "./hedera.js";

export function hashAuditPayload(canonicalPayload: string): string {
  return createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
}
