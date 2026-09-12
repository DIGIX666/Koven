import { createHash } from "node:crypto";

import {
  canonicalHash,
  signCreditOffer,
  type SignedCreditAcceptance,
} from "@koven/credit-protocol";
import type {
  CreditOffer,
  CreditRequest,
  Provider,
  ScanRequest,
  UnsignedCreditRequest,
} from "@koven/domain";
import { PrivateKey } from "@koven/hedera";
import type { X402Client } from "@koven/x402";
import { describe, expect, it, vi } from "vitest";

import {
  ConsumerMissionExecutor,
  ConsumerPaymentService,
  ConsumerServiceError,
  HttpCreditSigner,
  HttpLender,
  type ConsumerCreditSigner,
  type ConsumerLender,
  type ConsumerPayment,
} from "../src/index.js";

const now = "2026-09-13T10:00:00.000Z";
const borrowerAccountId = "0.0.1001";
const lenderAccountId = "0.0.2001";
const provider: Provider = {
  id: "provider-a",
  accountId: "0.0.3001",
  endpoint: "https://provider.example",
  capability: "solidity-scan",
  priceTinybar: 100n,
  reputationScore: 0.9,
  expectedLatencyMs: 50,
};
const source = "pragma solidity ^0.8.24; contract ConsumerFlow {}";
const targetSha256 = createHash("sha256").update(source, "utf8").digest("hex");
const transactionId = "0.0.4001@1789293600.000000001";
const fundingTxId = "0.0.2001@1789293600.000000002";
const signature = "a".repeat(128);

const unsignedRequest = (overrides: Partial<UnsignedCreditRequest> = {}): UnsignedCreditRequest => ({
  id: "credit-1",
  missionId: "mission-1",
  borrowerAccountId,
  principalTinybar: 99n,
  requestedTermSeconds: 3_600,
  purposeHash: canonicalHash({ missionId: "mission-1", targetSha256 }),
  createdAt: now,
  ...overrides,
});

const request = (overrides: Partial<CreditRequest> = {}): CreditRequest => ({
  ...unsignedRequest(),
  signature,
  ...overrides,
});

const offerTerms = (overrides: Partial<Omit<CreditOffer, "signature">> = {}) => ({
  id: "offer-1",
  requestId: "credit-1",
  lenderAccountId,
  principalTinybar: 99n,
  feeTinybar: 5n,
  termSeconds: 3_600,
  expiresAt: "2026-09-13T10:05:00.000Z",
  termsHash: "0".repeat(64),
  ...overrides,
});

const signedAcceptance = (offer: CreditOffer): SignedCreditAcceptance => ({
  acceptance: {
    requestId: offer.requestId,
    missionId: "mission-1",
    borrowerAccountId,
    lenderAccountId: offer.lenderAccountId,
    offerId: offer.id,
    termsHash: offer.termsHash,
    expiresAt: offer.expiresAt,
  },
  signature,
});

const paidResult = {
  status: 200 as const,
  receipt: {
    missionId: "mission-1",
    transactionId,
    network: "hedera:testnet" as const,
    payer: borrowerAccountId,
    recipientAccountId: provider.accountId,
    asset: "0.0.0" as const,
    amountTinybar: provider.priceTinybar,
    settledAt: now,
  },
  report: {
    schemaVersion: 1 as const,
    missionId: "mission-1",
    targetSha256,
    providerId: provider.id,
    findings: [],
    startedAt: now,
    completedAt: now,
    reportSha256: "b".repeat(64),
  },
};

describe("consumer credit HTTP adapters", () => {
  it("uses only typed signer routes and the consumer-role credential", async () => {
    const creditOffer = { ...offerTerms(), termsHash: "c".repeat(64), signature };
    const acceptance = signedAcceptance(creditOffer);
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      if (path === "/sign-credit-request") return new Response(JSON.stringify({ signature }), { status: 200 });
      return new Response(JSON.stringify(acceptance), { status: 200 });
    });
    const signer = new HttpCreditSigner({
      baseUrl: "https://signer.example",
      credential: "s".repeat(43),
      fetch: fetchMock,
    });

    expect(await signer.signCreditRequest(unsignedRequest())).toEqual(request());
    expect(await signer.signCreditAcceptance(creditOffer)).toEqual(acceptance);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${"s".repeat(43)}`);
    }
  });

  it("verifies lender signatures and rejects altered or expired offers before acceptance", async () => {
    const lenderKey = PrivateKey.generateECDSA();
    const terms = offerTerms();
    const valid = signCreditOffer({ ...terms, termsHash: canonicalHash({
      requestId: terms.requestId,
      lenderAccountId: terms.lenderAccountId,
      principalTinybar: terms.principalTinybar,
      feeTinybar: terms.feeTinybar,
      termSeconds: terms.termSeconds,
      expiresAt: terms.expiresAt,
    }) }, lenderKey);
    const { signature: _validSignature, ...validUnsigned } = valid;
    const wire = (offer: CreditOffer) => ({
      ...offer,
      principalTinybar: offer.principalTinybar.toString(10),
      feeTinybar: offer.feeTinybar.toString(10),
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(wire(valid)), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(wire({ ...valid, feeTinybar: 6n })), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(wire(signCreditOffer({
        ...validUnsigned,
        expiresAt: "2026-09-13T09:59:59.000Z",
        termsHash: canonicalHash({
          requestId: valid.requestId,
          lenderAccountId: valid.lenderAccountId,
          principalTinybar: valid.principalTinybar,
          feeTinybar: valid.feeTinybar,
          termSeconds: valid.termSeconds,
          expiresAt: "2026-09-13T09:59:59.000Z",
        }),
      }, lenderKey))), { status: 200 }));
    const lender = new HttpLender({
      baseUrl: "https://lender.example",
      publicKey: lenderKey.publicKey,
      fetch: fetchMock,
      now: () => now,
    });

    await expect(lender.quote(request())).resolves.toEqual(valid);
    await expect(lender.quote(request())).rejects.toMatchObject({ code: "offer_signature_invalid" });
    await expect(lender.quote(request())).rejects.toMatchObject({ code: "offer_expired" });
  });

  it("classifies a lost funding response as retryable without changing the acceptance", async () => {
    const creditOffer = { ...offerTerms(), termsHash: "c".repeat(64), signature };
    const acceptance = signedAcceptance(creditOffer);
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      throw new TypeError("connection closed");
    });
    const lender = new HttpLender({
      baseUrl: "https://lender.example",
      publicKey: PrivateKey.generateECDSA().publicKey,
      fetch: fetchMock,
    });

    await expect(lender.accept(acceptance)).rejects.toMatchObject({
      status: 503,
      code: "settlement_unconfirmed",
    });
    const sent = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(sent).toEqual(acceptance);
  });
});

describe("ConsumerPaymentService", () => {
  it("binds the real remote-signer flow to the selected provider without a proof bundle", async () => {
    const transaction = Buffer.from([1, 2, 3, 4]).toString("base64");
    const transactionSha256 = createHash("sha256").update(Buffer.from(transaction, "base64")).digest("hex");
    const requirements = {
      scheme: "exact" as const,
      network: "hedera:testnet" as const,
      asset: "0.0.0" as const,
      amount: provider.priceTinybar.toString(10),
      payTo: provider.accountId,
      maxTimeoutSeconds: 180,
      extra: { feePayer: "0.0.4001" },
    };
    const authorize = vi.fn(async () => ({
      transaction,
      paymentAuthorization: {
        missionId: "mission-1",
        targetSha256,
        transactionSha256,
        transactionId,
        borrowerAccountId,
        providerAccountId: provider.accountId,
        scanUrl: `${provider.endpoint}/scan`,
        amountTinybar: provider.priceTinybar.toString(10),
        network: "hedera:testnet" as const,
        asset: "0.0.0" as const,
        nonce: "7",
        expiresAt: "2026-09-13T10:03:00.000Z",
        signature,
      },
    }));
    const client: X402Client = {
      request: vi.fn(async () => ({ status: 402 as const, requirements })),
      retryWithPayment: vi.fn(async () => paidResult),
    };
    const payment = new ConsumerPaymentService({
      borrowerAccountId,
      authorizer: { authorize },
      nonce: () => "7",
      clientFactory: scanUrl => {
        expect(scanUrl).toBe(`${provider.endpoint}/scan`);
        return client;
      },
    });
    const scanRequest: ScanRequest = {
      missionId: "mission-1",
      targetRef: "ConsumerFlow.sol",
      source,
      targetSha256,
    };

    await expect(payment.pay(scanRequest, provider)).resolves.toEqual(paidResult);
    expect(authorize).toHaveBeenCalledWith({ missionId: "mission-1", requirements, nonce: "7" });
    expect(client.retryWithPayment).toHaveBeenCalledWith(
      expect.objectContaining({ missionId: "mission-1", paymentAuthorization: expect.any(Object) }),
      transaction,
    );
  });

  it("rejects a challenge for another provider before asking the signer", async () => {
    const authorize = vi.fn();
    const client: X402Client = {
      request: vi.fn(async () => ({
        status: 402 as const,
        requirements: {
          scheme: "exact" as const,
          network: "hedera:testnet" as const,
          asset: "0.0.0" as const,
          amount: "101",
          payTo: provider.accountId,
          maxTimeoutSeconds: 180,
          extra: { feePayer: "0.0.4001" },
        },
      })),
      retryWithPayment: vi.fn(),
    };
    const payment = new ConsumerPaymentService({
      borrowerAccountId,
      authorizer: { authorize },
      clientFactory: () => client,
    });

    await expect(payment.pay({
      missionId: "mission-1",
      targetRef: "ConsumerFlow.sol",
      source,
      targetSha256,
    }, provider)).rejects.toThrow(/selected provider/);
    expect(authorize).not.toHaveBeenCalled();
  });
});

describe("ConsumerMissionExecutor", () => {
  it("waits for funding registration before starting the paid scan", async () => {
    const order: string[] = [];
    const creditOffer = { ...offerTerms(), termsHash: "c".repeat(64), signature };
    const acceptance = signedAcceptance(creditOffer);
    const signer: ConsumerCreditSigner = {
      signCreditRequest: vi.fn(async creditRequest => {
        order.push("sign-request");
        return { ...creditRequest, signature };
      }),
      signCreditAcceptance: vi.fn(async () => {
        order.push("sign-acceptance");
        return acceptance;
      }),
    };
    let attempts = 0;
    const lender: ConsumerLender = {
      quote: vi.fn(async () => {
        order.push("quote");
        return creditOffer;
      }),
      accept: vi.fn(async () => {
        order.push("accept");
        attempts += 1;
        if (attempts < 3) throw new ConsumerServiceError(503, "settlement_unconfirmed", "registration pending");
        return { fundingTxId };
      }),
    };
    const payment: ConsumerPayment = {
      pay: vi.fn(async request => {
        order.push("pay");
        expect(request.targetSha256).toBe(targetSha256);
        return paidResult;
      }),
    };
    const executor = new ConsumerMissionExecutor({
      borrowerAccountId,
      balance: { getBalanceTinybar: vi.fn(async () => 1n) },
      signer,
      lender,
      payment,
      now: () => now,
      requestId: () => "credit-1",
      fundingRetryDelayMs: 1,
      wait: vi.fn(async () => undefined),
    });

    const result = await executor.execute({
      missionId: "mission-1",
      targetRef: "ConsumerFlow.sol",
      source,
      maxBudgetTinybar: 1_000n,
      provider,
    });

    expect(result.credit?.request.principalTinybar).toBe(99n);
    expect(result.credit?.fundingTxId).toBe(fundingTxId);
    expect(order).toEqual([
      "sign-request",
      "quote",
      "sign-acceptance",
      "accept",
      "accept",
      "accept",
      "pay",
    ]);
  });

  it("pays without contacting credit services when the balance is sufficient", async () => {
    const signer = {
      signCreditRequest: vi.fn(),
      signCreditAcceptance: vi.fn(),
    } as unknown as ConsumerCreditSigner;
    const lender = { quote: vi.fn(), accept: vi.fn() } as unknown as ConsumerLender;
    const payment = { pay: vi.fn(async () => paidResult) };
    const executor = new ConsumerMissionExecutor({
      borrowerAccountId,
      balance: { getBalanceTinybar: vi.fn(async () => 100n) },
      signer,
      lender,
      payment,
    });

    const result = await executor.execute({
      missionId: "mission-1",
      targetRef: "ConsumerFlow.sol",
      source,
      maxBudgetTinybar: 100n,
      provider,
    });

    expect(result.credit).toBeUndefined();
    expect(signer.signCreditRequest).not.toHaveBeenCalled();
    expect(lender.quote).not.toHaveBeenCalled();
    expect(payment.pay).toHaveBeenCalledTimes(1);
  });
});
