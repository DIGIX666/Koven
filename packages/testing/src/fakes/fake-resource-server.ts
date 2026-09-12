import type { PaidScanRequest, ScanReport } from "@koven/domain";
import type { ResourceServer } from "@koven/x402";

const DEFAULT_REPORT_HASH = "f".repeat(64);
const DEFAULT_TIMESTAMP = "2026-09-10T12:00:00.000Z";

export interface FakeResourceServerOptions {
  providerId?: string;
  reportSha256?: string;
  findings?: ScanReport["findings"];
  timestamp?: string;
}

export class FakeResourceServer implements ResourceServer {
  readonly requests: PaidScanRequest[] = [];
  private readonly options: Required<FakeResourceServerOptions>;
  private nextFailure: Error | undefined;

  constructor(options: FakeResourceServerOptions = {}) {
    this.options = {
      providerId: options.providerId ?? "provider-fake",
      reportSha256: options.reportSha256 ?? DEFAULT_REPORT_HASH,
      findings: structuredClone(options.findings ?? []),
      timestamp: options.timestamp ?? DEFAULT_TIMESTAMP,
    };
  }

  failNext(error = new Error("Injected resource server failure")): void {
    this.nextFailure = error;
  }

  async scan(request: PaidScanRequest): Promise<ScanReport> {
    this.requests.push(structuredClone(request));
    if (this.nextFailure !== undefined) {
      const error = this.nextFailure;
      this.nextFailure = undefined;
      throw error;
    }

    return {
      schemaVersion: 1,
      missionId: request.missionId,
      targetSha256: request.targetSha256,
      providerId: this.options.providerId,
      findings: structuredClone(this.options.findings),
      startedAt: this.options.timestamp,
      completedAt: this.options.timestamp,
      reportSha256: this.options.reportSha256,
    };
  }
}
