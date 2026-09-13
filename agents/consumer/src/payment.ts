import { randomBytes } from "node:crypto";

import type { NormalizedChallenge, PaymentRequirements, ProofBundle, Provider, ScanRequest } from "@koven/domain";
import { ProviderSchema, ScanRequestSchema } from "@koven/schemas";
import {
  ChallengeRejectedError,
  HttpX402Client,
  normalizeChallenge,
  RemoteRestrictedSigner,
  type PaidResourceResponse,
  type PaymentAuthorizer,
  type X402Client,
} from "@koven/x402";
import type { MissionPolicy } from "@koven/zk-policy";

import { type ConsumerProver, rethrowPolicyRejection } from "./proof.js";

/** A challenge obtained and, in zk mode, proven before credit; the same intent pays afterwards. */
export interface PreparedPayment {
  readonly request: ScanRequest;
  readonly provider: Provider;
  readonly requirements: PaymentRequirements;
  readonly intent: NormalizedChallenge;
  readonly bundle?: ProofBundle;
  readonly client: X402Client;
}

export interface ConsumerPayment {
  prepare(request: ScanRequest, provider: Provider, policy: MissionPolicy): Promise<PreparedPayment>;
  pay(prepared: PreparedPayment, observer?: ConsumerPaymentObserver): Promise<PaidResourceResponse>;
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
  /** Present in the zk deployment: every payment is proven before credit acceptance. */
  readonly prover?: ConsumerProver;
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

  /**
   * Obtains the provider's 402 challenge, checks it against the selected
   * provider, normalises it into the payment intent and, in zk mode, proves it
   * against the mission policy. Nothing here contacts the signer.
   */
  async prepare(input: ScanRequest, provider: Provider, policy: MissionPolicy): Promise<PreparedPayment> {
    const request = ScanRequestSchema.parse(input);
    ProviderSchema.parse({ ...provider, priceTinybar: provider.priceTinybar.toString(10) });
    const scanUrl = `${provider.endpoint}/scan`;
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
    const intent = normalizeChallenge(challenge.requirements, request.missionId, request.targetSha256, this.nonce(), { scanUrl });
    const prepared = { request, provider, requirements: challenge.requirements, intent, client };
    if (this.options.prover === undefined) return prepared;
    try {
      return { ...prepared, bundle: await this.options.prover.prove(intent, policy) };
    } catch (error) {
      rethrowPolicyRejection(error);
    }
  }

  /** Pays with the prepared intent: the signer authorizes it (with its proof in zk mode) and the paid retry follows. */
  async pay(prepared: PreparedPayment, observer?: ConsumerPaymentObserver): Promise<PaidResourceResponse> {
    const { request, provider, intent, bundle, client } = prepared;
    const signer = new RemoteRestrictedSigner(
      this.options.borrowerAccountId,
      {
        missionId: request.missionId,
        targetSha256: request.targetSha256,
        nonce: intent.nonce,
        scanUrl: `${provider.endpoint}/scan`,
        ...(bundle ? { bundle } : {}),
      },
      this.options.authorizer,
    );

    let transaction: string;
    try {
      transaction = await signer.createPartiallySignedTransferTransaction(prepared.requirements);
    } catch (error) {
      rethrowPolicyRejection(error);
    }
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
