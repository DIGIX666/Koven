import type { PaidScanRequest, ScanRequest } from "@koven/domain";
import type { PaidResourceResponse, PaymentRequiredResponse, X402Client } from "@koven/x402";

export type FakeX402Operation = "request" | "retryWithPayment";

export interface PaidRetryCall {
  request: PaidScanRequest;
  signedTransaction: string;
}

export interface FakeX402ClientOptions {
  challenge: PaymentRequiredResponse;
  settlement: PaidResourceResponse;
}

export class FakeX402Client implements X402Client {
  readonly requests: ScanRequest[] = [];
  readonly paidRetries: PaidRetryCall[] = [];
  private readonly failures = new Map<FakeX402Operation, Error[]>();
  private challenge: PaymentRequiredResponse;
  private settlement: PaidResourceResponse;

  constructor(options: FakeX402ClientOptions) {
    this.challenge = structuredClone(options.challenge);
    this.settlement = structuredClone(options.settlement);
  }

  setChallenge(challenge: PaymentRequiredResponse): void {
    this.challenge = structuredClone(challenge);
  }

  setSettlement(settlement: PaidResourceResponse): void {
    this.settlement = structuredClone(settlement);
  }

  failNext(operation: FakeX402Operation, error = new Error(`Injected ${operation} failure`)): void {
    const queued = this.failures.get(operation) ?? [];
    queued.push(error);
    this.failures.set(operation, queued);
  }

  async request(request: ScanRequest): Promise<PaymentRequiredResponse> {
    this.requests.push(structuredClone(request));
    this.throwQueuedFailure("request");
    return structuredClone(this.challenge);
  }

  async retryWithPayment(
    request: PaidScanRequest,
    signedTransaction: string,
  ): Promise<PaidResourceResponse> {
    this.paidRetries.push({ request: structuredClone(request), signedTransaction });
    this.throwQueuedFailure("retryWithPayment");
    return structuredClone(this.settlement);
  }

  private throwQueuedFailure(operation: FakeX402Operation): void {
    const queued = this.failures.get(operation);
    const error = queued?.shift();
    if (queued?.length === 0) this.failures.delete(operation);
    if (error !== undefined) throw error;
  }
}
