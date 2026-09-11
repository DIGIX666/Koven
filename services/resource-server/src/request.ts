import { createHash } from "node:crypto";

import { ErrorCode, type ScanRequest } from "@koven/domain";
import { MAX_SOURCE_BYTES, ScanRequestSchema } from "@koven/schemas";

export type ScanRequestErrorCode =
  | typeof ErrorCode.REQUEST_INVALID
  | typeof ErrorCode.SOURCE_HASH_MISMATCH
  | typeof ErrorCode.SOURCE_TOO_LARGE
  | typeof ErrorCode.INTERNAL_ERROR;

export class ScanServiceError extends Error {
  constructor(
    readonly code: ScanRequestErrorCode,
    readonly status: 400 | 413 | 500,
    detail: string,
  ) {
    super(detail);
    this.name = "ScanServiceError";
  }
}

export function hashSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function scanRequestFields(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  return {
    missionId: record.missionId,
    targetRef: record.targetRef,
    source: record.source,
    targetSha256: record.targetSha256,
  };
}

export function parseBoundScanRequest(input: unknown): ScanRequest {
  return parseCandidate(input);
}

/** Extracts and validates base scan fields from the stricter paid request. */
export function parseBoundPaidScanRequestBase(input: unknown): ScanRequest {
  return parseCandidate(scanRequestFields(input));
}

function parseCandidate(candidate: unknown): ScanRequest {
  if (
    typeof candidate === "object"
    && candidate !== null
    && "source" in candidate
    && typeof candidate.source === "string"
    && Buffer.byteLength(candidate.source, "utf8") > MAX_SOURCE_BYTES
  ) {
    throw new ScanServiceError(ErrorCode.SOURCE_TOO_LARGE, 413, "Solidity source exceeds 256 KiB");
  }

  const parsed = ScanRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ScanServiceError(ErrorCode.REQUEST_INVALID, 400, "Invalid scan request");
  }

  if (hashSource(parsed.data.source) !== parsed.data.targetSha256) {
    throw new ScanServiceError(ErrorCode.SOURCE_HASH_MISMATCH, 400, "Source does not match targetSha256");
  }

  return parsed.data;
}
