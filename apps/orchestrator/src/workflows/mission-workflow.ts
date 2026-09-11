import { randomUUID } from "node:crypto";

import { ALLOWED_TRANSITIONS, type CreditOffer, type Loan, type MissionState, type Provider, type RankedProvider, type ScanPaymentAuthorization } from "@koven/domain";
import type { HederaAdapter } from "@koven/hedera";
import {
  createLoan,
  createMission,
  getMission,
  reserveSpending,
  updateLoanState,
  type KovenDatabase,
  type PersistedMission,
} from "@koven/persistence";
import type { HttpRequest } from "@koven/schemas";
import type { X402Client } from "@koven/x402";
import type { ClientHederaSigner } from "@x402/hedera";

import type { CompletionHandler } from "../callbacks/index.js";
import { hashBase64, hashBytes, hashCanonicalJson } from "../canonical.js";
import type { MissionStateMachine } from "../state/index.js";

const FAKE_SIGNATURE = "b".repeat(128);

class PolicyRejectedError extends Error {}

export interface MissionWorkflowOptions {
  database: KovenDatabase;
  stateMachine: MissionStateMachine;
  completionHandler: CompletionHandler;
  hedera: HederaAdapter;
  signer: ClientHederaSigner;
  x402Client: X402Client;
  providers: readonly Provider[];
  borrowerAccountId: string;
  lenderAccountId: string;
  approvedRecipientsRoot: string;
  now?: () => string;
  missionId?: () => string;
  loanFeeTinybar?: bigint;
}

/** Deterministic Track A workflow. Agent reasoning stays outside this sequence. */
export class MissionWorkflow {
  private readonly now: () => string;
  private readonly missionId: () => string;
  private readonly loanFeeTinybar: bigint;

  constructor(private readonly options: MissionWorkflowOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.missionId = options.missionId ?? (() => `mission-${randomUUID()}`);
    this.loanFeeTinybar = options.loanFeeTinybar ?? 1n;
  }

  async run(request: HttpRequest<"createMission">): Promise<PersistedMission> {
    const id = this.missionId();
    const targetSha256 = hashBytes(request.source);
    const createdAt = this.now();
    createMission(this.options.database, {
      id,
      state: "created",
      spendingCapTinybar: BigInt(request.maxBudgetTinybar),
      spentTinybar: 0n,
      approvedRecipientsRoot: this.options.approvedRecipientsRoot,
      targetRef: request.targetRef,
      targetSha256,
      createdAt,
      updatedAt: createdAt,
    });

    let state: MissionState = "created";
    let loan: Loan | undefined;
    const move = async (
      to: MissionState,
      type: Parameters<MissionStateMachine["transition"]>[3]["type"],
      payload: unknown,
      transactionId?: string,
    ): Promise<void> => {
      const audit = transactionId === undefined ? { type, payload } : { type, payload, transactionId };
      await this.options.stateMachine.transition(id, state, to, audit);
      state = to;
    };

    try {
      await move("discovering-services", "mission-created", {
        promptHash: hashBytes(request.prompt),
        targetRef: request.targetRef,
        targetSha256,
      });
      const ranked = rankProviders(this.options.providers, BigInt(request.maxBudgetTinybar));
      const selected = ranked[0];
      if (selected === undefined) {
        await move("payment-preparation", "providers-ranked", { ranked });
        throw new PolicyRejectedError("No provider is available");
      }

      const provider = selected.provider;
      const balance = await this.options.hedera.getBalanceTinybar(this.options.borrowerAccountId);
      const requiredCredit = checkBudget(balance, provider.priceTinybar);
      if (provider.priceTinybar > BigInt(request.maxBudgetTinybar)) {
        await move("payment-preparation", "providers-ranked", { ranked });
        throw new PolicyRejectedError("Selected provider exceeds the mission budget");
      }

      if (requiredCredit > 0n) {
        await move("credit-requested", "credit-requested", { principalTinybar: requiredCredit });
        const offers = requestCredit(
          id,
          requiredCredit,
          this.loanFeeTinybar,
          this.options.lenderAccountId,
          this.now(),
        );
        const offer = selectOffer(offers);
        loan = await this.acceptOffer(id, offer);
        await move("funded", "loan-funded", { loanId: loan.id, fundingTxId: loan.fundingTxId });
        await move("payment-preparation", "offer-accepted", { offerId: offer.id });
      } else {
        await move("payment-preparation", "providers-ranked", { ranked });
      }

      const scanRequest = {
        missionId: id,
        targetRef: request.targetRef,
        source: request.source,
        targetSha256,
      };
      const challenge = await this.options.x402Client.request(scanRequest);
      const amountTinybar = validateChallenge(
        challenge.requirements,
        provider,
        BigInt(request.maxBudgetTinybar),
      );
      const signedTransaction = await this.options.signer
        .createPartiallySignedTransferTransaction(challenge.requirements);
      const transactionSha256 = hashBase64(signedTransaction);
      reserveSpending(this.options.database, {
        missionId: id,
        nonce: "1",
        paymentCommitment: transactionSha256,
        amountTinybar,
        consumedAt: this.now(),
      });
      const authorization = createAuthorization(
        id,
        targetSha256,
        transactionSha256,
        provider,
        challenge.requirements.maxTimeoutSeconds,
        this.options.borrowerAccountId,
        this.now(),
      );
      await move("payment-authorized", "payment-authorized", {
        providerId: provider.id,
        amountTinybar,
        nonce: authorization.nonce,
      });

      const paid = await this.options.x402Client.retryWithPayment(
        { ...scanRequest, paymentAuthorization: authorization },
        signedTransaction,
      );
      validateSettlement(id, targetSha256, provider, amountTinybar, paid);
      await move("service-paid", "x402-settled", {
        providerId: provider.id,
        amountTinybar,
      }, paid.receipt.transactionId);
      await move("running", "x402-settled", { providerId: provider.id });

      const callback = {
        outcome: {
          missionId: id,
          delivered: true as const,
          reportSha256: paid.report.reportSha256,
          settlementTxId: paid.receipt.transactionId,
          observedAt: this.now(),
        },
        report: paid.report,
      };
      const callbackTimestamp = String(Math.floor(Date.parse(this.now()) / 1000));
      await this.options.completionHandler.receive(callback, {
        idempotencyKey: `mission-complete:${id}:${paid.report.reportSha256}`,
        timestamp: callbackTimestamp,
        signature: hashCanonicalJson(callback),
      });
      state = "completed";

      if (loan === undefined) {
        await move("closed", "mission-completed", { reportSha256: paid.report.reportSha256 });
      } else {
        await move("repayment-pending", "mission-completed", { loanId: loan.id });
        const repaymentTxId = await this.repay(loan);
        await move("repaid", "repayment-settled", { loanId: loan.id, repaymentTxId });
        await move("closed", "repayment-settled", { loanId: loan.id });
      }
    } catch (error) {
      await this.finishFailure(id, state, loan, move, error);
    }

    const completed = getMission(this.options.database, id);
    if (completed === undefined) throw new Error(`Mission disappeared during workflow: ${id}`);
    return completed;
  }

  private async acceptOffer(missionId: string, offer: CreditOffer): Promise<Loan> {
    const loan: Loan = {
      id: `loan-${missionId}`,
      offerId: offer.id,
      missionId,
      lenderAccountId: offer.lenderAccountId,
      principalTinybar: offer.principalTinybar,
      feeTinybar: offer.feeTinybar,
      state: "offered",
    };
    createLoan(this.options.database, loan);
    updateLoanState(this.options.database, loan.id, "offered", "accepted");
    const funding = await this.options.hedera.transferHbar({
      from: this.options.lenderAccountId,
      to: this.options.borrowerAccountId,
      amountTinybar: loan.principalTinybar,
      memo: `fund:${loan.id}`,
    });
    updateLoanState(this.options.database, loan.id, "accepted", "funded", {
      fundingTxId: funding.transactionId,
    });
    return { ...loan, state: "funded", fundingTxId: funding.transactionId };
  }

  private async repay(loan: Loan): Promise<string> {
    const repayment = await this.options.hedera.transferHbar({
      from: this.options.borrowerAccountId,
      to: loan.lenderAccountId,
      amountTinybar: loan.principalTinybar + loan.feeTinybar,
      memo: `repay:${loan.id}`,
    });
    updateLoanState(this.options.database, loan.id, "funded", "repaid", {
      repaymentTxId: repayment.transactionId,
    });
    return repayment.transactionId;
  }

  private async finishFailure(
    missionId: string,
    initialState: MissionState,
    loan: Loan | undefined,
    move: (
      to: MissionState,
      type: Parameters<MissionStateMachine["transition"]>[3]["type"],
      payload: unknown,
      transactionId?: string,
    ) => Promise<void>,
    error: unknown,
  ): Promise<void> {
    let state = initialState;
    const reason = error instanceof Error ? error.message : "Unknown workflow failure";
    const moveFailure = async (to: MissionState, type: "payment-rejected" | "mission-failed") => {
      await move(to, type, { reason });
      state = to;
    };

    if (error instanceof PolicyRejectedError && state === "payment-preparation") {
      await moveFailure("policy-rejected", "payment-rejected");
    } else if (state === "repayment-pending") {
      await moveFailure("defaulted", "mission-failed");
      return;
    } else if ((ALLOWED_TRANSITIONS[state] as readonly MissionState[]).includes("failed")) {
      await moveFailure("failed", "mission-failed");
    }

    if (state === "policy-rejected" || state === "failed") {
      await moveFailure("recovery", "mission-failed");
    }
    if (state !== "recovery") return;

    if (loan === undefined) {
      await moveFailure("closed", "mission-failed");
      return;
    }

    await moveFailure("repayment-pending", "mission-failed");
    try {
      const repaymentTxId = await this.repay(loan);
      await move("repaid", "repayment-settled", { loanId: loan.id, repaymentTxId });
      await move("closed", "repayment-settled", { loanId: loan.id });
    } catch {
      await moveFailure("defaulted", "mission-failed");
    }

    if (getMission(this.options.database, missionId) === undefined) {
      throw new Error(`Mission disappeared during recovery: ${missionId}`);
    }
  }
}

export function rankProviders(
  providers: readonly Provider[],
  maxBudgetTinybar: bigint,
): RankedProvider[] {
  const denominator = Number(maxBudgetTinybar === 0n ? 1n : maxBudgetTinybar);
  return providers.map(provider => {
    const price = 1 - Math.min(Number(provider.priceTinybar) / denominator, 1);
    const reputation = provider.reputationScore;
    const latency = 1 / (1 + provider.expectedLatencyMs / 1_000);
    return {
      provider,
      score: price * 0.4 + reputation * 0.4 + latency * 0.2,
      breakdown: { price, reputation, latency },
    };
  }).sort((left, right) => right.score - left.score || left.provider.id.localeCompare(right.provider.id));
}

export const checkBudget = (balanceTinybar: bigint, priceTinybar: bigint): bigint => (
  balanceTinybar >= priceTinybar ? 0n : priceTinybar - balanceTinybar
);

export function requestCredit(
  missionId: string,
  principalTinybar: bigint,
  feeTinybar: bigint,
  lenderAccountId: string,
  now: string,
): CreditOffer[] {
  const requestId = `credit-${missionId}`;
  const termSeconds = 3_600;
  const expiresAt = new Date(Date.parse(now) + termSeconds * 1_000).toISOString();
  const termsHash = hashCanonicalJson({
    requestId,
    lenderAccountId,
    principalTinybar,
    feeTinybar,
    termSeconds,
    expiresAt,
  });
  return [{
    id: `offer-${missionId}`,
    requestId,
    lenderAccountId,
    principalTinybar,
    feeTinybar,
    termSeconds,
    expiresAt,
    termsHash,
    signature: FAKE_SIGNATURE,
  }];
}

export function selectOffer(offers: readonly CreditOffer[]): CreditOffer {
  const selected = [...offers].sort((left, right) => {
    if (left.feeTinybar !== right.feeTinybar) return left.feeTinybar < right.feeTinybar ? -1 : 1;
    return left.id.localeCompare(right.id);
  })[0];
  if (selected === undefined) throw new Error("No credit offer is available");
  return selected;
}

function validateChallenge(
  requirements: Parameters<ClientHederaSigner["createPartiallySignedTransferTransaction"]>[0],
  provider: Provider,
  missionCapTinybar: bigint,
): bigint {
  const amount = BigInt(requirements.amount);
  if (requirements.scheme !== "exact"
    || requirements.network !== "hedera:testnet"
    || requirements.asset !== "0.0.0"
    || requirements.payTo !== provider.accountId
    || amount !== provider.priceTinybar
    || amount > missionCapTinybar) {
    throw new PolicyRejectedError("x402 challenge does not satisfy the mission policy");
  }
  return amount;
}

function createAuthorization(
  missionId: string,
  targetSha256: string,
  transactionSha256: string,
  provider: Provider,
  timeoutSeconds: number,
  borrowerAccountId: string,
  now: string,
): ScanPaymentAuthorization {
  const timestamp = Date.parse(now);
  const transactionId = `${borrowerAccountId}@${Math.floor(timestamp / 1_000)}.000000001`;
  return {
    missionId,
    targetSha256,
    transactionSha256,
    transactionId,
    borrowerAccountId,
    providerAccountId: provider.accountId,
    scanUrl: `${provider.endpoint}/scan`,
    amountTinybar: provider.priceTinybar,
    network: "hedera:testnet",
    asset: "0.0.0",
    nonce: "1",
    expiresAt: new Date(timestamp + timeoutSeconds * 1_000).toISOString(),
    signature: FAKE_SIGNATURE,
  };
}

function validateSettlement(
  missionId: string,
  targetSha256: string,
  provider: Provider,
  amountTinybar: bigint,
  paid: Awaited<ReturnType<X402Client["retryWithPayment"]>>,
): void {
  if (paid.receipt.missionId !== missionId
    || paid.receipt.recipientAccountId !== provider.accountId
    || paid.receipt.amountTinybar !== amountTinybar
    || paid.report.missionId !== missionId
    || paid.report.targetSha256 !== targetSha256
    || paid.report.providerId !== provider.id) {
    throw new Error("Paid resource response is not bound to the mission");
  }
}
