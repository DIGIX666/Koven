import { createHash, randomUUID } from "node:crypto";

import { canonicalHash, type SignedCreditAcceptance } from "@koven/credit-protocol";
import { ErrorCode, type CreditOffer, type CreditRequest, type Provider, type ScanRequest } from "@koven/domain";
import { selectCreditOffer, type RankedCreditOffer } from "@koven/policy";
import { ProviderSchema, ScanRequestSchema, TinybarString } from "@koven/schemas";

import {
  ConsumerServiceError,
  type ConsumerCreditSigner,
  type ConsumerLender,
  type CreditEvidence,
} from "./credit.js";
import type { ConsumerPayment, ConsumerPaymentProgress, PreparedPayment } from "./payment.js";
import { paymentIntentWire, rethrowPolicyRejection } from "./proof.js";

const hashSource = (source: string): string => createHash("sha256").update(source, "utf8").digest("hex");

export interface ConsumerBalanceReader {
  getBalanceTinybar(accountId: string): Promise<bigint>;
}

export interface ConsumerMissionInput {
  readonly missionId: string;
  readonly targetRef: string;
  readonly source: string;
  readonly maxBudgetTinybar: bigint;
  readonly provider: Provider;
  readonly requestedTermSeconds?: number;
  readonly creditEvidence?: CreditEvidence;
}

export interface ConsumerMissionResult {
  readonly scan: Awaited<ReturnType<ConsumerPayment["pay"]>>;
  readonly credit?: {
    readonly request: CreditRequest;
    readonly offer: CreditOffer;
    readonly acceptance: SignedCreditAcceptance;
    readonly fundingTxId: string;
  };
}

export type ConsumerMissionProgress =
  | { readonly type: "payment-preparation" }
  | { readonly type: "offers-received"; readonly ranked: readonly RankedCreditOffer[]; readonly selectedOfferId: string }
  | {
    /** M3: the policy proof bound to the payment intent, produced before credit acceptance. */
    readonly type: "proof-generated";
    readonly nonce: string;
    readonly publicSignals: readonly [string, string, string];
    readonly vkeyHash: string;
  }
  | ConsumerPaymentProgress
  | {
    readonly type: "credit-requested";
    readonly request: CreditRequest;
  }
  | {
    readonly type: "funded";
    readonly request: CreditRequest;
    readonly offer: CreditOffer;
    readonly acceptance: SignedCreditAcceptance;
    readonly fundingTxId: string;
  };

export interface ConsumerMissionObserver {
  onProgress(event: ConsumerMissionProgress): Promise<void>;
}

export interface ConsumerMissionExecutorOptions {
  readonly borrowerAccountId: string;
  readonly balance: ConsumerBalanceReader;
  readonly signer: ConsumerCreditSigner;
  readonly lenders: readonly ConsumerLender[];
  readonly payment: ConsumerPayment;
  readonly now?: () => string;
  readonly requestId?: () => string;
  readonly fundingMaxAttempts?: number;
  readonly fundingRetryDelayMs?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

const defaultWait = (milliseconds: number): Promise<void> => new Promise(resolve => {
  setTimeout(resolve, milliseconds);
});

/**
 * Keyless consumer sequence (M3 order): obtain and normalise the provider's
 * challenge, prove it against the mission policy, bind the intent and proof
 * into the signed credit acceptance, wait for funding and registration, then
 * pay with that same bound intent.
 */
export class ConsumerMissionExecutor {
  private readonly now: () => string;
  private readonly requestId: () => string;
  private readonly fundingMaxAttempts: number;
  private readonly fundingRetryDelayMs: number;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: ConsumerMissionExecutorOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.requestId = options.requestId ?? (() => `credit-${randomUUID()}`);
    this.fundingMaxAttempts = options.fundingMaxAttempts ?? 10;
    this.fundingRetryDelayMs = options.fundingRetryDelayMs ?? 1_000;
    this.wait = options.wait ?? defaultWait;
    if (!Number.isInteger(this.fundingMaxAttempts) || this.fundingMaxAttempts < 1 || this.fundingMaxAttempts > 100) {
      throw new RangeError("Funding attempts must be between 1 and 100");
    }
    if (!Number.isInteger(this.fundingRetryDelayMs) || this.fundingRetryDelayMs < 1 || this.fundingRetryDelayMs > 60_000) {
      throw new RangeError("Funding retry delay must be between 1 and 60000 ms");
    }
    if (options.lenders.length === 0) throw new Error("At least one lender is required");
  }

  async execute(
    input: ConsumerMissionInput,
    observer?: ConsumerMissionObserver,
  ): Promise<ConsumerMissionResult> {
    TinybarString.parse(input.maxBudgetTinybar.toString(10));
    ProviderSchema.parse({
      ...input.provider,
      priceTinybar: input.provider.priceTinybar.toString(10),
    });
    if (input.provider.priceTinybar > input.maxBudgetTinybar) {
      throw new Error("Selected provider exceeds the mission budget");
    }
    const scanRequest: ScanRequest = ScanRequestSchema.parse({
      missionId: input.missionId,
      targetRef: input.targetRef,
      source: input.source,
      targetSha256: hashSource(input.source),
    });
    // The challenge and its proof come first, so the credit acceptance can bind
    // the exact payment intent and the lender can verify it before funding.
    const prepared: PreparedPayment = await this.options.payment.prepare(scanRequest, input.provider, {
      capTinybar: input.maxBudgetTinybar,
      approvedRecipients: [input.provider.accountId],
    });
    if (prepared.bundle !== undefined) {
      await observer?.onProgress({
        type: "proof-generated",
        nonce: prepared.intent.nonce,
        publicSignals: prepared.bundle.publicSignals,
        vkeyHash: prepared.bundle.vkeyHash,
      });
    }

    // An insufficient balance borrows the whole payment amount: the protocol
    // requires the accepted principal to cover the bound intent, so the lender
    // can verify that what it funds is exactly what is paid.
    const balance = await this.options.balance.getBalanceTinybar(this.options.borrowerAccountId);
    const principalTinybar = input.provider.priceTinybar > balance ? input.provider.priceTinybar : 0n;

    let credit: ConsumerMissionResult["credit"];
    if (principalTinybar > 0n) {
      const unsigned = {
        id: this.requestId(),
        missionId: input.missionId,
        borrowerAccountId: this.options.borrowerAccountId,
        principalTinybar,
        requestedTermSeconds: input.requestedTermSeconds ?? 600,
        purposeHash: canonicalHash({ missionId: input.missionId, targetSha256: scanRequest.targetSha256 }),
        createdAt: this.now(),
      };
      try {
        const request = await this.options.signer.signCreditRequest(unsigned);
        await observer?.onProgress({ type: "credit-requested", request });
        const { lender, offer, ranked } = await this.selectLender(request);
        await observer?.onProgress({ type: "offers-received", ranked, selectedOfferId: offer.id });
        const evidence: CreditEvidence = prepared.bundle !== undefined
          ? { paymentIntent: paymentIntentWire(prepared.intent), paymentProofBundle: prepared.bundle }
          : (input.creditEvidence ?? {});
        const acceptance = await this.options.signer.signCreditAcceptance(offer, evidence);
        const { fundingTxId } = await this.awaitFunding(lender, acceptance, evidence);
        credit = { request, offer, acceptance, fundingTxId };
      } catch (error) {
        rethrowPolicyRejection(error);
      }
      await observer?.onProgress({ type: "funded", ...credit });
    }

    await observer?.onProgress({ type: "payment-preparation" });
    const scan = await this.options.payment.pay(prepared, observer);
    return credit === undefined ? { scan } : { scan, credit };
  }

  private async selectLender(request: CreditRequest): Promise<{
    lender: ConsumerLender;
    offer: CreditOffer;
    ranked: readonly RankedCreditOffer[];
  }> {
    const responses = await Promise.all(this.options.lenders.map(async lender => {
      try {
        return { lender, offer: await lender.quote(request) };
      } catch (error) {
        return { lender, offer: null, error };
      }
    }));
    const candidates = responses.filter(
      (candidate): candidate is { lender: ConsumerLender; offer: CreditOffer; error?: never } => candidate.offer !== null,
    );
    const selection = selectCreditOffer(candidates.map(candidate => candidate.offer), {
      requiredPrincipalTinybar: request.principalTinybar,
      now: this.now(),
      verifySignature: offer => candidates.some(candidate => (
        candidate.offer === offer && candidate.lender.isOfferValid(offer, request)
      )),
    });
    if (selection === null) {
      const failure = responses.find(candidate => "error" in candidate);
      if (failure?.error !== undefined) throw failure.error;
      throw new Error("All lenders declined the credit request");
    }
    const selected = candidates.find(candidate => candidate.offer === selection.winner);
    if (selected === undefined) throw new Error("Selected offer has no lender client");
    return { ...selected, ranked: selection.ranked };
  }

  private async awaitFunding(
    lender: ConsumerLender,
    acceptance: SignedCreditAcceptance,
    evidence: CreditEvidence,
  ): Promise<{ fundingTxId: string }> {
    for (let attempt = 1; attempt <= this.fundingMaxAttempts; attempt += 1) {
      try {
        return await lender.accept(acceptance, evidence);
      } catch (error) {
        const pending = error instanceof ConsumerServiceError
          && error.status === 503
          && error.code === ErrorCode.SETTLEMENT_UNCONFIRMED;
        if (!pending || attempt === this.fundingMaxAttempts) throw error;
        await this.wait(this.fundingRetryDelayMs);
      }
    }
    throw new Error("Funding attempts exhausted");
  }
}
