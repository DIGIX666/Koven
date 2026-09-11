import { randomUUID } from "node:crypto";

import {
  AbstractHook,
  AgentMode,
  type Context,
  type PostCoreActionParams,
} from "@hashgraph/hedera-agent-kit";
import {
  coreAccountPluginToolNames,
  transferHbarTool,
} from "@hashgraph/hedera-agent-kit/plugins";
import {
  canonicalHash,
  CreditProtocolError,
  type SignedCreditAcceptance,
} from "@koven/credit-protocol";
import { ErrorCode, type CreditOffer, type CreditRequest } from "@koven/domain";
import { explorerUrl, Transaction, TransactionId, type Client } from "@koven/hedera";
import {
  CreditAcceptResponseSchema,
  LoanRegistrationRequestSchema,
  LoanRegistrationResponseSchema,
  type HttpRequest,
  type HttpResponse,
} from "@koven/schemas";

import { type FundingRecord, LenderStore } from "./store.js";

export interface FundingTransfer {
  fromAccountId: string;
  toAccountId: string;
  amountTinybar: bigint;
  memo: string;
  onPrepared(transactionId: string): void;
}

export interface FundingGateway {
  transfer(input: FundingTransfer): Promise<{ transactionId: string }>;
  reconcile(
    transactionId: string,
    expected: Pick<FundingTransfer, "fromAccountId" | "toAccountId" | "amountTinybar">,
  ): Promise<"confirmed" | "pending" | "failed">;
}

export interface LoanRegistrationClient {
  register(request: HttpRequest<"registerLoan">): Promise<void>;
}

class PersistTransactionHook extends AbstractHook {
  name = "persist-koven-funding-transaction";
  description = "Persists the stable funding transaction ID before submission";
  relevantTools = [coreAccountPluginToolNames.TRANSFER_HBAR_TOOL];

  constructor(
    private readonly accountId: string,
    private readonly persist: (transactionId: string) => void,
  ) {
    super();
  }

  override async postCoreActionHook(params: PostCoreActionParams, method: string): Promise<void> {
    if (!this.appliesToMethod(method)) return;
    if (!(params.coreActionResult instanceof Transaction)) {
      throw new Error("transfer_hbar_tool did not build a Hedera transaction");
    }
    const transaction = params.coreActionResult;
    if (transaction.transactionId === null) {
      transaction.setTransactionId(TransactionId.generate(this.accountId));
    }
    const transactionId = transaction.transactionId?.toString();
    if (transactionId === undefined) throw new Error("Funding transaction has no ID");
    this.persist(transactionId);
  }
}

const tinybarToHbar = (amountTinybar: bigint): number => {
  const amount = Number(amountTinybar) / 100_000_000;
  if (!Number.isFinite(amount)
    || BigInt(Math.round(amount * 100_000_000)) !== amountTinybar) {
    throw new RangeError("Funding amount cannot be represented exactly by transfer_hbar_tool");
  }
  return amount;
};

/** Invokes Hedera Agent Kit's transfer_hbar_tool directly in autonomous mode. */
export class AgentKitFundingGateway implements FundingGateway {
  readonly mode = AgentMode.AUTONOMOUS;
  readonly toolName = coreAccountPluginToolNames.TRANSFER_HBAR_TOOL;

  constructor(
    private readonly client: Client,
    private readonly accountId: string,
    private readonly reconciler: Pick<FundingGateway, "reconcile">,
  ) {}

  async transfer(input: FundingTransfer): Promise<{ transactionId: string }> {
    if (input.fromAccountId !== this.accountId) {
      throw new CreditProtocolError(ErrorCode.FUNDING_MISMATCH, "Funding source is not the lender");
    }
    const context: Context = {
      mode: AgentMode.AUTONOMOUS,
      accountId: this.accountId,
      hooks: [new PersistTransactionHook(this.accountId, input.onPrepared)],
    };
    const tool = transferHbarTool(context);
    const result = await tool.execute(this.client, context, {
      sourceAccountId: this.accountId,
      transfers: [{ accountId: input.toAccountId, amount: tinybarToHbar(input.amountTinybar) }],
      transactionMemo: input.memo,
    }) as { raw?: { status?: string; transactionId?: string; error?: string } };
    if (result.raw?.status !== "SUCCESS" || result.raw.transactionId === undefined) {
      throw new Error(result.raw?.error ?? "Hedera Agent Kit funding failed");
    }
    return { transactionId: result.raw.transactionId };
  }

  reconcile(
    transactionId: string,
    expected: Pick<FundingTransfer, "fromAccountId" | "toAccountId" | "amountTinybar">,
  ) {
    return this.reconciler.reconcile(transactionId, expected);
  }
}

const asRecord = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Mirror Node response");
  }
  return value as Record<string, unknown>;
};

/** Confirms the stored transaction and its exact parties through a trusted Mirror Node. */
export class MirrorNodeFundingReconciler implements Pick<FundingGateway, "reconcile"> {
  private readonly mirrorOrigin: URL;

  constructor(mirrorNodeUrl: string, private readonly timeoutMs = 10_000) {
    const origin = new URL(mirrorNodeUrl);
    const loopback = origin.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    if ((!loopback && origin.protocol !== "https:")
      || origin.username || origin.password || origin.search || origin.hash
      || origin.pathname !== "/") {
      throw new Error("Mirror Node URL must be an HTTPS or loopback origin");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new RangeError("Mirror timeout must be between 1 and 60000 ms");
    }
    this.mirrorOrigin = origin;
  }

  async reconcile(
    transactionId: string,
    expected: Pick<FundingTransfer, "fromAccountId" | "toAccountId" | "amountTinybar">,
  ): Promise<"confirmed" | "pending" | "failed"> {
    explorerUrl(transactionId);
    const id = transactionId.replace("@", "-").replace(/\.(\d{9})$/, "-$1");
    const response = await fetch(
      new URL(`/api/v1/transactions/${id}`, this.mirrorOrigin),
      { signal: AbortSignal.timeout(this.timeoutMs), redirect: "error" },
    );
    if (response.status === 404) return "pending";
    if (!response.ok) throw new Error(`Mirror Node returned HTTP ${response.status}`);
    const rows = asRecord(await response.json()).transactions;
    if (!Array.isArray(rows) || rows.length === 0) return "pending";
    const match = rows.map(asRecord).find(row => row.transaction_id === id && row.nonce === 0);
    if (match === undefined) return "pending";
    if (match.result !== "SUCCESS" || match.name !== "CRYPTOTRANSFER") return "failed";
    if (!Array.isArray(match.transfers)) throw new Error("Mirror transaction has no HBAR transfers");
    const net = new Map<string, bigint>();
    for (const raw of match.transfers) {
      const transfer = asRecord(raw);
      if (typeof transfer.account !== "string"
        || typeof transfer.amount !== "number"
        || !Number.isSafeInteger(transfer.amount)) {
        throw new Error("Mirror transaction contains an imprecise transfer");
      }
      net.set(transfer.account, (net.get(transfer.account) ?? 0n) + BigInt(transfer.amount));
    }
    const wrongDebit = [...net].some(([account, amount]) => (
      amount < 0n && account !== expected.fromAccountId
    ));
    return net.get(expected.toAccountId) === expected.amountTinybar
      && (net.get(expected.fromAccountId) ?? 0n) <= -expected.amountTinybar
      && !wrongDebit
      ? "confirmed"
      : "failed";
  }
}

export class HttpLoanRegistrationClient implements LoanRegistrationClient {
  private readonly baseUrl: URL;

  constructor(baseUrl: string, private readonly credential: string, private readonly timeoutMs = 10_000) {
    const origin = new URL(baseUrl);
    const loopback = origin.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    if ((!loopback && origin.protocol !== "https:")
      || origin.username || origin.password || origin.search || origin.hash
      || origin.pathname !== "/") {
      throw new Error("Restricted signer URL must be an HTTPS or loopback origin");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new RangeError("Signer timeout must be between 1 and 60000 ms");
    }
    this.baseUrl = origin;
  }

  async register(request: HttpRequest<"registerLoan">): Promise<void> {
    const parsed = LoanRegistrationRequestSchema.parse(request);
    const response = await fetch(new URL("/internal/loans/register", this.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(parsed),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Restricted signer returned HTTP ${response.status}`);
    const registered = LoanRegistrationResponseSchema.parse(await response.json());
    if (registered.loanId !== parsed.loanId) {
      throw new Error("Restricted signer acknowledged another loan");
    }
  }
}

export interface FundingServiceOptions {
  store: LenderStore;
  gateway: FundingGateway;
  registrationClient: LoanRegistrationClient;
  lenderAccountId: string;
  now?: () => string;
  preparationLeaseMs?: number;
}

/** Funds once, reconciles uncertain submissions, and retries only signer registration. */
export class FundingService {
  private readonly now: () => string;
  private readonly preparationLeaseMs: number;

  constructor(private readonly options: FundingServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.preparationLeaseMs = options.preparationLeaseMs ?? 30_000;
    if (!Number.isInteger(this.preparationLeaseMs) || this.preparationLeaseMs < 1) {
      throw new RangeError("Funding preparation lease must be a positive integer");
    }
  }

  async accept(
    request: CreditRequest,
    offer: CreditOffer,
    signed: SignedCreditAcceptance,
  ): Promise<HttpResponse<"accept">> {
    const acceptanceJson = JSON.stringify(signed);
    let funding = this.options.store.reserveFunding(
      offer.id,
      canonicalHash(signed),
      acceptanceJson,
      this.now(),
    );
    const expected = {
      fromAccountId: this.options.lenderAccountId,
      toAccountId: request.borrowerAccountId,
      amountTinybar: offer.principalTinybar,
    };

    if (funding.status === "registered") return this.response(funding);
    if (funding.transactionId !== undefined
      && (funding.status === "preparing" || funding.status === "pending")) {
      const reconciliation = await this.options.gateway.reconcile(funding.transactionId, expected);
      if (reconciliation !== "confirmed") {
        throw new CreditProtocolError(
          reconciliation === "failed" ? ErrorCode.FUNDING_MISMATCH : ErrorCode.SETTLEMENT_UNCONFIRMED,
          reconciliation === "failed" ? "Funding transaction failed" : "Funding is not confirmed yet",
        );
      }
      this.options.store.markFundingConfirmed(funding.id, funding.transactionId, this.now());
      funding = { ...funding, status: "confirmed" };
    }

    if (funding.transactionId === undefined) {
      const claimedAt = this.now();
      const staleBefore = new Date(Date.parse(claimedAt) - this.preparationLeaseMs).toISOString();
      const submissionToken = randomUUID();
      if (!this.options.store.claimFundingSubmission(
        funding.id,
        submissionToken,
        claimedAt,
        staleBefore,
      )) {
        throw new CreditProtocolError(
          ErrorCode.SETTLEMENT_UNCONFIRMED,
          "Another funding attempt is preparing the transaction",
        );
      }
      try {
        const result = await this.options.gateway.transfer({
          ...expected,
          memo: `fund:${funding.id}`,
          onPrepared: transactionId => this.options.store.setFundingTransaction(
            funding.id,
            submissionToken,
            transactionId,
            this.now(),
          ),
        });
        this.options.store.setFundingTransaction(
          funding.id,
          submissionToken,
          result.transactionId,
          this.now(),
        );
        this.options.store.markFundingConfirmed(funding.id, result.transactionId, this.now());
        funding = { ...funding, transactionId: result.transactionId, status: "confirmed" };
      } catch (error) {
        const prepared = this.options.store.getFundingByOffer(offer.id);
        if (prepared?.transactionId !== undefined) {
          throw new CreditProtocolError(
            ErrorCode.SETTLEMENT_UNCONFIRMED,
            "Funding submission outcome is uncertain; reconcile the stored transaction",
          );
        }
        this.options.store.releaseFundingSubmission(funding.id, submissionToken, this.now());
        throw error;
      }
    }

    const registration = this.registrationRequest(request, offer, signed, funding);
    this.options.store.enqueueRegistration(funding.id, registration);
    const pending = this.options.store.pendingRegistration(funding.id);
    if (pending !== undefined) {
      try {
        await this.options.registrationClient.register(
          LoanRegistrationRequestSchema.parse(pending),
        );
        this.options.store.markRegistered(funding.id, this.now());
      } catch (error) {
        this.options.store.recordRegistrationFailure(funding.id, error);
        throw new CreditProtocolError(
          ErrorCode.SETTLEMENT_UNCONFIRMED,
          "Funding is confirmed but signer registration is pending",
        );
      }
    }
    return this.response({ ...funding, status: "registered" });
  }

  private registrationRequest(
    request: CreditRequest,
    offer: CreditOffer,
    signed: SignedCreditAcceptance,
    funding: FundingRecord,
  ): HttpRequest<"registerLoan"> {
    if (funding.transactionId === undefined) {
      throw new CreditProtocolError(ErrorCode.SETTLEMENT_UNCONFIRMED, "Funding has no transaction ID");
    }
    return LoanRegistrationRequestSchema.parse({
      loanId: `loan-${canonicalHash({ offerId: offer.id }).slice(0, 32)}`,
      request: { ...request, principalTinybar: request.principalTinybar.toString(10) },
      offer: {
        ...offer,
        principalTinybar: offer.principalTinybar.toString(10),
        feeTinybar: offer.feeTinybar.toString(10),
      },
      acceptance: signed.acceptance,
      signatures: { acceptance: signed.signature },
      fundingTxId: funding.transactionId,
    });
  }

  private response(funding: FundingRecord): HttpResponse<"accept"> {
    if (funding.transactionId === undefined) {
      throw new CreditProtocolError(ErrorCode.SETTLEMENT_UNCONFIRMED, "Funding has no transaction ID");
    }
    return CreditAcceptResponseSchema.parse({ fundingTxId: funding.transactionId });
  }
}
