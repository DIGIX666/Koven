import { randomBytes } from "node:crypto";

import type { Provider, ScanRequest } from "@koven/domain";
import { ProviderSchema, ScanRequestSchema } from "@koven/schemas";
import {
  ChallengeRejectedError,
  HttpX402Client,
  RemoteRestrictedSigner,
  type PaidResourceResponse,
  type PaymentAuthorizer,
  type X402Client,
} from "@koven/x402";

export interface ConsumerPayment {
  pay(
    request: ScanRequest,
    provider: Provider,
    observer?: ConsumerPaymentObserver,
  ): Promise<PaidResourceResponse>;
}

export type ConsumerPaymentProgress =
  | {
    readonly type: "payment-authorized";
    readonly transactionId: string;
    readonly nonce: string;
    readonly amountTinybar: bigint;
  }
  | {
    readonly type: "service-paid";
    readonly scan: PaidResourceResponse;
  };

export interface ConsumerPaymentObserver {
  onProgress(event: ConsumerPaymentProgress): Promise<void>;
}

export interface ConsumerPaymentServiceOptions {
  readonly borrowerAccountId: string;
  readonly authorizer: PaymentAuthorizer;
  readonly fetch?: typeof fetch;
  readonly now?: () => string;
  readonly nonce?: () => string;
  readonly clientFactory?: (scanUrl: string) => X402Client;
}

const randomNonce = (): string => BigInt(`0x${randomBytes(31).toString("hex")}`).toString(10);

/** Executes one source-bound x402 payment using only the remote restricted signer. */
export class ConsumerPaymentService implements ConsumerPayment {
  private readonly nonce: () => string;

  constructor(private readonly options: ConsumerPaymentServiceOptions) {
    this.nonce = options.nonce ?? randomNonce;
  }

  async pay(
    input: ScanRequest,
    provider: Provider,
    observer?: ConsumerPaymentObserver,
  ): Promise<PaidResourceResponse> {
    const request = ScanRequestSchema.parse(input);
    ProviderSchema.parse({ ...provider, priceTinybar: provider.priceTinybar.toString(10) });
    const scanUrl = `${provider.endpoint}/scan`;
    const signer = new RemoteRestrictedSigner(
      this.options.borrowerAccountId,
      {
        missionId: request.missionId,
        targetSha256: request.targetSha256,
        nonce: this.nonce(),
        scanUrl,
      },
      this.options.authorizer,
    );
    const client = this.options.clientFactory?.(scanUrl) ?? new HttpX402Client({
      scanUrl,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
    });

    const challenge = await client.request(request);
    if (
      challenge.requirements.payTo !== provider.accountId
      || BigInt(challenge.requirements.amount) !== provider.priceTinybar
      || challenge.requirements.maxTimeoutSeconds !== 180
    ) throw new ChallengeRejectedError("challenge does not match the selected provider");

    const transaction = await signer.createPartiallySignedTransferTransaction(challenge.requirements);
    const authorization = signer.authorizationFor(transaction);
    if (authorization === undefined) {
      throw new ChallengeRejectedError("restricted signer returned no bound authorization");
    }
    await observer?.onProgress({
      type: "payment-authorized",
      transactionId: authorization.transactionId,
      nonce: authorization.nonce,
      amountTinybar: BigInt(authorization.amountTinybar),
    });
    const paid = await client.retryWithPayment({
      ...request,
      paymentAuthorization: {
        ...authorization,
        amountTinybar: BigInt(authorization.amountTinybar),
      },
    }, transaction);
    if (
      paid.report.providerId !== provider.id
      || paid.receipt.payer !== this.options.borrowerAccountId
      || paid.receipt.recipientAccountId !== provider.accountId
      || paid.receipt.amountTinybar !== provider.priceTinybar
    ) throw new ChallengeRejectedError("paid response does not match the selected provider");
    await observer?.onProgress({ type: "service-paid", scan: paid });
    return paid;
  }
}
