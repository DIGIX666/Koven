import type { ClientHederaSigner } from "@x402/hedera";

export type SignerPaymentRequirements = Parameters<
  ClientHederaSigner["createPartiallySignedTransferTransaction"]
>[0];

export class FakeSigner implements ClientHederaSigner {
  readonly requirements: SignerPaymentRequirements[] = [];
  private sequence = 0;
  private nextFailure: Error | undefined;

  constructor(readonly accountId = "0.0.10") {}

  failNext(error = new Error("Injected signer failure")): void {
    this.nextFailure = error;
  }

  async createPartiallySignedTransferTransaction(
    requirements: SignerPaymentRequirements,
  ): Promise<string> {
    this.requirements.push(structuredClone(requirements));
    if (this.nextFailure !== undefined) {
      const error = this.nextFailure;
      this.nextFailure = undefined;
      throw error;
    }

    this.sequence += 1;
    return Buffer.from(`fake-signed-transaction:${this.accountId}:${this.sequence}`).toString("base64");
  }
}
