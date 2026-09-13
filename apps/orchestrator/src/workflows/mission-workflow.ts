import { randomUUID } from "node:crypto";

import {
  ConsumerPolicyRejectedError,
  type ConsumerMissionExecutor,
  type ConsumerMissionProgress,
  type ConsumerMissionResult,
} from "@koven/consumer-agent";
import { loanIdForOffer } from "@koven/credit-protocol";
import { ALLOWED_TRANSITIONS, type Loan, type MissionState, type Provider, type RankedProvider } from "@koven/domain";
import {
  createLoan,
  createMission,
  getMission,
  saveMissionPolicy,
  type KovenDatabase,
  type PersistedMission,
} from "@koven/persistence";
import { rankProviders } from "@koven/policy";
import type { HttpRequest } from "@koven/schemas";
import { type FieldHasher, loadPoseidon } from "@koven/x402";
import { buildMissionRecipientRoot } from "@koven/zk-policy";

import { hashBytes } from "../canonical.js";
import type { MissionStateMachine } from "../state/index.js";

class PolicyRejectedError extends Error {}

export interface MissionPolicyRegistrar {
  register(policy: HttpRequest<"registerMissionPolicy">): Promise<void>;
}

export interface MissionWorkflowOptions {
  readonly database: KovenDatabase;
  readonly stateMachine: MissionStateMachine;
  readonly consumer: Pick<ConsumerMissionExecutor, "execute">;
  readonly policyRegistrars: readonly MissionPolicyRegistrar[];
  readonly providers: readonly Provider[];
  readonly borrowerAccountId: string;
  /** Poseidon used for the singleton recipient root; loaded on first use when omitted. */
  readonly poseidon?: FieldHasher;
  readonly now?: () => string;
  readonly missionId?: () => string;
  readonly sessionId?: (missionId: string) => string;
}

/**
 * Coordinates trusted policy provisioning around the keyless consumer sequence.
 * The mission's approved recipient set is the selected provider alone, so its
 * `approvedRecipientsRoot` is that provider's singleton Merkle root.
 */
export class MissionWorkflow {
  private readonly now: () => string;
  private readonly missionId: () => string;
  private readonly sessionId: (missionId: string) => string;
  private poseidon: FieldHasher | undefined;

  constructor(private readonly options: MissionWorkflowOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.missionId = options.missionId ?? (() => `mission-${randomUUID()}`);
    this.sessionId = options.sessionId ?? (missionId => `session-${missionId}`);
    this.poseidon = options.poseidon;
    if (options.policyRegistrars.length === 0) {
      throw new Error("At least one trusted mission-policy registrar is required");
    }
    if (options.providers.length === 0) {
      throw new Error("At least one provider is required");
    }
  }

  /** Singleton recipient root of the selected provider, as the signer and lender recompute it. */
  async recipientRoot(providerAccountId: string): Promise<string> {
    this.poseidon ??= await loadPoseidon();
    return buildMissionRecipientRoot(providerAccountId, this.poseidon);
  }

  async run(request: HttpRequest<"createMission">): Promise<PersistedMission> {
    const id = this.missionId();
    const targetSha256 = hashBytes(request.source);
    const createdAt = this.now();
    const spendingCapTinybar = BigInt(request.maxBudgetTinybar);
    const ranked = rankProviders(this.options.providers, {
      capability: "solidity-scan",
      maxPriceTinybar: spendingCapTinybar,
    });
    const selected = ranked[0];
    if (selected === undefined) throw new Error("No provider is configured");
    const provider = selected.provider;
    // The selected provider is the mission's whole approved recipient set, even
    // when its price is then rejected against the budget.
    const approvedRecipientsRoot = await this.recipientRoot(provider.accountId);
    createMission(this.options.database, {
      id,
      state: "created",
      spendingCapTinybar,
      spentTinybar: 0n,
      approvedRecipientsRoot,
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
      persistAdditionalState?: () => void,
    ): Promise<void> => {
      const audit = transactionId === undefined ? { type, payload } : { type, payload, transactionId };
      await this.options.stateMachine.transition(id, state, to, audit, persistAdditionalState);
      state = to;
    };

    try {
      await move("discovering-services", "mission-created", {
        promptHash: hashBytes(request.prompt),
        targetRef: request.targetRef,
        targetSha256,
      });
      if (provider.priceTinybar > spendingCapTinybar) {
        await move("payment-preparation", "providers-ranked", { ranked });
        throw new PolicyRejectedError("Selected provider exceeds the mission budget");
      }

      const sessionId = this.sessionId(id);
      saveMissionPolicy(this.options.database, {
        missionId: id,
        borrowerAccountId: this.options.borrowerAccountId,
        spendingCapTinybar,
        sessionId,
        sessionCapTinybar: spendingCapTinybar,
        targetSha256,
        provider,
        approvedRecipientsRoot,
        createdAt,
      });
      const policy = {
        missionId: id,
        borrowerAccountId: this.options.borrowerAccountId,
        spendingCapTinybar: spendingCapTinybar.toString(10),
        sessionId,
        sessionCapTinybar: spendingCapTinybar.toString(10),
        targetSha256,
        provider: { ...provider, priceTinybar: provider.priceTinybar.toString(10) },
        approvedRecipientsRoot,
      } satisfies HttpRequest<"registerMissionPolicy">;
      await Promise.all(this.options.policyRegistrars.map(registrar => registrar.register(policy)));

      const result = await this.options.consumer.execute(
        {
          missionId: id,
          targetRef: request.targetRef,
          source: request.source,
          maxBudgetTinybar: spendingCapTinybar,
          provider,
        },
        {
          onProgress: async event => {
            switch (event.type) {
              case "proof-generated":
                // Proven before credit: an audit fact, not a stored state.
                await this.options.stateMachine.record(id, {
                  type: "proof-generated",
                  payload: {
                    nonce: event.nonce,
                    publicSignals: event.publicSignals,
                    vkeyHash: event.vkeyHash,
                  },
                });
                return;
              case "credit-requested":
                await move("credit-requested", "credit-requested", {
                  requestId: event.request.id,
                  principalTinybar: event.request.principalTinybar,
                });
                return;
              case "funded": {
                const fundedLoan = this.loanFromFunding(id, event);
                await move(
                  "funded",
                  "offer-accepted",
                  { offerId: event.offer.id, fundingTxId: event.fundingTxId },
                  event.fundingTxId,
                  () => createLoan(this.options.database, fundedLoan),
                );
                loan = fundedLoan;
                return;
              }
              case "payment-preparation":
                if (state === "funded" && loan !== undefined) {
                  await move("payment-preparation", "loan-funded", {
                    loanId: loan.id,
                    fundingTxId: loan.fundingTxId,
                  }, loan.fundingTxId);
                  return;
                }
                if (state === "discovering-services") {
                  await move("payment-preparation", "providers-ranked", { ranked });
                  return;
                }
                throw new PolicyRejectedError(`Payment preparation is invalid from ${state}`);
              case "payment-authorized":
                await move("payment-authorized", "payment-authorized", {
                  providerId: provider.id,
                  amountTinybar: event.amountTinybar,
                  nonce: event.nonce,
                }, event.transactionId);
                return;
              case "service-paid":
                this.assertScanResult(id, targetSha256, provider, event.scan);
                await move("service-paid", "x402-settled", {
                  providerId: provider.id,
                  amountTinybar: event.scan.receipt.amountTinybar,
                }, event.scan.receipt.transactionId);
                return;
            }
          },
        },
      );
      this.assertConsumerResult(id, targetSha256, provider, result, loan);
      if ((state as MissionState) !== "service-paid") {
        throw new PolicyRejectedError("Consumer did not report paid-service progress");
      }
      await move("running", "report-received", {
        providerId: provider.id,
        reportSha256: result.scan.report.reportSha256,
      });
    } catch (error) {
      await this.finishFailure(state, loan, ranked, move, error);
    }

    const completed = getMission(this.options.database, id);
    if (completed === undefined) throw new Error(`Mission disappeared during workflow: ${id}`);
    return completed;
  }

  private loanFromFunding(
    missionId: string,
    event: Extract<ConsumerMissionProgress, { type: "funded" }>,
  ): Loan {
    this.assertCreditBinding(missionId, event);
    return {
      id: loanIdForOffer(event.offer.id),
      offerId: event.offer.id,
      missionId,
      lenderAccountId: event.offer.lenderAccountId,
      principalTinybar: event.offer.principalTinybar,
      feeTinybar: event.offer.feeTinybar,
      state: "funded",
      fundingTxId: event.fundingTxId,
    };
  }

  private assertConsumerResult(
    missionId: string,
    targetSha256: string,
    provider: Provider,
    result: ConsumerMissionResult,
    loan: Loan | undefined,
  ): void {
    this.assertScanResult(missionId, targetSha256, provider, result.scan);
    if (result.credit === undefined) {
      if (loan !== undefined) throw new PolicyRejectedError("Consumer omitted previously funded credit");
      return;
    }
    this.assertCreditBinding(missionId, result.credit);
    if (loan === undefined
      || loan.id !== loanIdForOffer(result.credit.offer.id)
      || loan.offerId !== result.credit.offer.id
      || loan.lenderAccountId !== result.credit.offer.lenderAccountId
      || loan.principalTinybar !== result.credit.offer.principalTinybar
      || loan.feeTinybar !== result.credit.offer.feeTinybar
      || loan.fundingTxId !== result.credit.fundingTxId) {
      throw new PolicyRejectedError("Consumer result differs from persisted funded credit");
    }
  }

  private assertScanResult(
    missionId: string,
    targetSha256: string,
    provider: Provider,
    scan: ConsumerMissionResult["scan"],
  ): void {
    if (
      scan.receipt.missionId !== missionId
      || scan.receipt.payer !== this.options.borrowerAccountId
      || scan.receipt.recipientAccountId !== provider.accountId
      || scan.receipt.amountTinybar !== provider.priceTinybar
      || scan.report.missionId !== missionId
      || scan.report.targetSha256 !== targetSha256
      || scan.report.providerId !== provider.id
    ) throw new PolicyRejectedError("Consumer result is not bound to the selected mission and provider");
  }

  private assertCreditBinding(
    missionId: string,
    credit: Extract<ConsumerMissionProgress, { type: "funded" }> | NonNullable<ConsumerMissionResult["credit"]>,
  ): void {
    const accepted = credit.acceptance.acceptance;
    if (credit.request.missionId !== missionId
      || credit.request.borrowerAccountId !== this.options.borrowerAccountId
      || credit.offer.requestId !== credit.request.id
      || credit.offer.principalTinybar !== credit.request.principalTinybar
      || accepted.requestId !== credit.request.id
      || accepted.missionId !== missionId
      || accepted.borrowerAccountId !== this.options.borrowerAccountId
      || accepted.lenderAccountId !== credit.offer.lenderAccountId
      || accepted.offerId !== credit.offer.id
      || accepted.termsHash !== credit.offer.termsHash
      || accepted.expiresAt !== credit.offer.expiresAt) {
      throw new PolicyRejectedError("Consumer credit is not bound to the mission and accepted offer");
    }
  }

  /**
   * A policy rejection (the workflow's own budget checks, or a signer, lender
   * or witness refusal carrying a frozen policy code) is recorded with its code
   * and routed through `policy-rejected` to `recovery`; anything else is a
   * generic failure. The frozen transition table only reaches `policy-rejected`
   * from `payment-preparation`, so a proof refused before credit is first
   * ranked into `payment-preparation`, while a refusal during credit acceptance
   * can only reach `recovery` through `failed`.
   */
  private async finishFailure(
    initialState: MissionState,
    loan: Loan | undefined,
    ranked: readonly RankedProvider[],
    move: (
      to: MissionState,
      type: Parameters<MissionStateMachine["transition"]>[3]["type"],
      payload: unknown,
      transactionId?: string,
      persistAdditionalState?: () => void,
    ) => Promise<void>,
    error: unknown,
  ): Promise<void> {
    let state = initialState;
    const reason = error instanceof Error ? error.message : "Unknown workflow failure";
    const policyRejection = error instanceof PolicyRejectedError || error instanceof ConsumerPolicyRejectedError;
    const payload = error instanceof ConsumerPolicyRejectedError ? { reason, code: error.code } : { reason };
    const moveFailure = async (to: MissionState, type: "payment-rejected" | "mission-failed") => {
      await move(to, type, payload);
      state = to;
    };

    if (error instanceof ConsumerPolicyRejectedError && state === "discovering-services") {
      await move("payment-preparation", "providers-ranked", { ranked });
      state = "payment-preparation";
    }
    if (policyRejection && state === "payment-preparation") {
      await moveFailure("policy-rejected", "payment-rejected");
    } else if ((ALLOWED_TRANSITIONS[state] as readonly MissionState[]).includes("failed")) {
      await moveFailure("failed", "mission-failed");
    }
    if (state === "policy-rejected" || state === "failed") {
      await moveFailure("recovery", "mission-failed");
    }
    if (state !== "recovery") return;
    await moveFailure(loan === undefined ? "closed" : "defaulted", "mission-failed");
  }
}
