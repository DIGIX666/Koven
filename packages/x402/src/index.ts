import type {
  PaidScanRequest,
  PaymentReceipt,
  PaymentRequirements,
  ScanReport,
  ScanRequest,
} from "@koven/domain";

export interface PaymentRequiredResponse {
  status: 402;
  requirements: PaymentRequirements;
}

export interface PaidResourceResponse {
  status: 200;
  receipt: PaymentReceipt;
  report: ScanReport;
}

/** Client boundary for the initial 402 response and the paid retry. */
export interface X402Client {
  request(request: ScanRequest): Promise<PaymentRequiredResponse>;
  retryWithPayment(
    request: PaidScanRequest,
    signedTransaction: string,
  ): Promise<PaidResourceResponse>;
}

/** Metered resource boundary called after payment authorization. */
export interface ResourceServer {
  scan(request: PaidScanRequest): Promise<ScanReport>;
}

/** x402 challenge normalization and Blocky402 settlement adapters. */
export const x402PackageStatus = "scaffolded" as const;
