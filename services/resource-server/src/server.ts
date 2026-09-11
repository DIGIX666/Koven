import { createHash } from "node:crypto";

import { ErrorCode, type ScanReport, type ScanRequest } from "@koven/domain";
import { MAX_SOURCE_BYTES, ScanRequestSchema } from "@koven/schemas";

import { buildReport } from "./report.js";
import { SolhintScanEngine, type ScanEngine } from "./scan.js";

export class ScanServiceError extends Error {
  constructor(
    readonly code: typeof ErrorCode.REQUEST_INVALID | typeof ErrorCode.SOURCE_HASH_MISMATCH | typeof ErrorCode.SOURCE_TOO_LARGE,
    readonly status: 400 | 413,
    detail: string,
  ) {
    super(detail);
    this.name = "ScanServiceError";
  }
}

export function hashSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export function parseBoundScanRequest(input: unknown): ScanRequest {
  if (
    typeof input === "object"
    && input !== null
    && "source" in input
    && typeof input.source === "string"
    && Buffer.byteLength(input.source, "utf8") > MAX_SOURCE_BYTES
  ) {
    throw new ScanServiceError(ErrorCode.SOURCE_TOO_LARGE, 413, "Solidity source exceeds 256 KiB");
  }

  const parsed = ScanRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new ScanServiceError(ErrorCode.REQUEST_INVALID, 400, "Invalid scan request");
  }

  if (hashSource(parsed.data.source) !== parsed.data.targetSha256) {
    throw new ScanServiceError(ErrorCode.SOURCE_HASH_MISMATCH, 400, "Source does not match targetSha256");
  }

  return parsed.data;
}

export interface ScanService {
  scan(input: unknown): Promise<ScanReport>;
}

export interface ScanServiceOptions {
  readonly providerId: string;
  readonly engine?: ScanEngine;
  readonly now?: () => Date;
}

/** Creates the validated scanning core; HTTP and payment adapters wrap this boundary. */
export function createScanService(options: ScanServiceOptions): ScanService {
  const engine = options.engine ?? new SolhintScanEngine();
  const now = options.now ?? (() => new Date());

  return {
    async scan(input: unknown): Promise<ScanReport> {
      const request = parseBoundScanRequest(input);
      const startedAt = now().toISOString();
      const findings = await engine.scan(request.source, request.targetRef);
      const completedAt = now().toISOString();
      return buildReport(request, options.providerId, findings, { startedAt, completedAt });
    },
  };
}
