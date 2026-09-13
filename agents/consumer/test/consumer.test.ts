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
import { normalizeChallenge, X402RequestError, type X402Client } from "@koven/x402";
import { WitnessError } from "@koven/zk-policy";
import { describe, expect, it, vi } from "vitest";

import {
  ConsumerMissionExecutor,
  ConsumerPaymentService,
  ConsumerPolicyRejectedError,
  ConsumerServiceError,
  HttpCreditSigner,
  HttpLender,
  paymentIntentWire,
  type ConsumerCreditSigner,
  type ConsumerLender,
  type ConsumerPayment,
  type ConsumerProver,
  type PreparedPayment,
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
  principalTinybar: 100n,
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
  principalTinybar: 100n,
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

const scanRequest: ScanRequest = {
  missionId: "mission-1",
  targetRef: "ConsumerFlow.sol",
  source,
  targetSha256,
};
const requirements = {
  scheme: "exact" as const,
  network: "hedera:testnet" as const,
  asset: "0.0.0" as const,
  amount: provider.priceTinybar.toString(10),
  payTo: provider.accountId,
  maxTimeoutSeconds: 180,
  extra: { feePayer: "0.0.4001" },
};
const policy = { capTinybar: 1_000n, approvedRecipients: [provider.accountId] };
const bundle = {
  proof: {
    protocol: "groth16" as const,
    curve: "bn128" as const,
    pi_a: ["1", "2", "1"] as [string, string, string],
    pi_b: [["1", "2"], ["3", "4"], ["1", "0"]] as [[string, string], [string, string], [string, string]],
    pi_c: ["5", "6", "1"] as [string, string, string],
  },
  publicSignals: ["11", "22", "1000"] as [string, string, string],
  vkeyHash: "d".repeat(64),
  circuitId: "koven-policy-v1",
};
const prepared = (overrides: Partial<PreparedPayment> = {}): PreparedPayment => ({
  request: scanRequest,
  provider,
  requirements,
  intent: normalizeChallenge(requirements, "mission-1", targetSha256, "7", { scanUrl: `${provider.endpoint}/scan` }),
  client: { request: vi.fn(), retryWithPayment: vi.fn() },
  ...overrides,
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
    expect(lender.isOfferValid(valid, request())).toBe(true);
    expect(lender.isOfferValid({ ...valid, feeTinybar: 6n }, request())).toBe(false);
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
  const authorization = (transaction: string) => ({
    transaction,
    paymentAuthorization: {
      missionId: "mission-1",
      targetSha256,
      transactionSha256: createHash("sha256").update(Buffer.from(transaction, "base64")).digest("hex"),
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
  });

  it("prepares the intent without the signer, then pays with that exact intent and bundle", async () => {
    const order: string[] = [];
    const transaction = Buffer.from([1, 2, 3, 4]).toString("base64");
    const authorize = vi.fn(async () => {
      order.push("authorize");
      return authorization(transaction);
    });
    const client: X402Client = {
      request: vi.fn(async () => {
        order.push("request");
        return { status: 402 as const, requirements };
      }),
      retryWithPayment: vi.fn(async () => {
        order.push("retry-with-payment");
        return paidResult;
      }),
    };
    const prover: ConsumerProver = {
      prove: vi.fn(async () => {
        order.push("prove");
        return bundle;
      }),
    };
    const payment = new ConsumerPaymentService({
      borrowerAccountId,
      authorizer: { authorize },
      prover,
      nonce: () => "7",
      clientFactory: scanUrl => {
        expect(scanUrl).toBe(`${provider.endpoint}/scan`);
        return client;
      },
    });

    const ready = await payment.prepare(scanRequest, provider, policy);
    expect(order).toEqual(["request", "prove"]);
    expect(authorize).not.toHaveBeenCalled();
    expect(ready.intent).toEqual(prepared().intent);
    expect(ready.bundle).toBe(bundle);
    expect(prover.prove).toHaveBeenCalledWith(ready.intent, policy);

    const progress = vi.fn(async event => { order.push(event.type); });
    await expect(payment.pay(ready, { onProgress: progress })).resolves.toEqual(paidResult);
    expect(authorize).toHaveBeenCalledWith({ missionId: "mission-1", requirements, nonce: "7", bundle });
    expect(client.retryWithPayment).toHaveBeenCalledWith(
      expect.objectContaining({ missionId: "mission-1", paymentAuthorization: expect.any(Object) }),
      transaction,
    );
    expect(order).toEqual(["request", "prove", "authorize", "payment-authorized", "retry-with-payment", "service-paid"]);
    expect(progress).toHaveBeenNthCalledWith(1, {
      type: "payment-authorized",
      transactionId,
      nonce: "7",
      amountTinybar: provider.priceTinybar,
    });
  });

  it("sends no bundle in deterministic mode", async () => {
    const authorize = vi.fn(async () => authorization(Buffer.from([9]).toString("base64")));
    const client: X402Client = {
      request: vi.fn(async () => ({ status: 402 as const, requirements })),
      retryWithPayment: vi.fn(async () => paidResult),
    };
    const payment = new ConsumerPaymentService({
      borrowerAccountId,
      authorizer: { authorize },
      nonce: () => "7",
      clientFactory: () => client,
    });

    const ready = await payment.prepare(scanRequest, provider, policy);
    expect(ready.bundle).toBeUndefined();
    await payment.pay(ready);
    expect(authorize).toHaveBeenCalledWith({ missionId: "mission-1", requirements, nonce: "7" });
  });

  it("rejects a challenge for another provider before proving or asking the signer", async () => {
    const authorize = vi.fn();
    const prover: ConsumerProver = { prove: vi.fn() };
    const client: X402Client = {
      request: vi.fn(async () => ({
        status: 402 as const,
        requirements: { ...requirements, amount: "101" },
      })),
      retryWithPayment: vi.fn(),
    };
    const payment = new ConsumerPaymentService({
      borrowerAccountId,
      authorizer: { authorize },
      prover,
      clientFactory: () => client,
    });

    await expect(payment.prepare(scanRequest, provider, policy)).rejects.toThrow(/selected provider/);
    expect(prover.prove).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("surfaces witness and signer policy refusals with their frozen codes", async () => {
    const client: X402Client = {
      request: vi.fn(async () => ({ status: 402 as const, requirements })),
      retryWithPayment: vi.fn(),
    };
    const refusing = new ConsumerPaymentService({
      borrowerAccountId,
      authorizer: { authorize: vi.fn() },
      prover: { prove: vi.fn(async () => { throw new WitnessError("cap_exceeded", "amount exceeds the cap"); }) },
      clientFactory: () => client,
    });
    await expect(refusing.prepare(scanRequest, provider, policy)).rejects.toMatchObject({
      name: "ConsumerPolicyRejectedError",
      code: "cap_exceeded",
    });

    const signerRefuses = new ConsumerPaymentService({
      borrowerAccountId,
      authorizer: { authorize: vi.fn(async () => { throw new X402RequestError(403, "recipient_not_approved", "recipient"); }) },
      clientFactory: () => client,
    });
    await expect(signerRefuses.pay(prepared())).rejects.toMatchObject({
      name: "ConsumerPolicyRejectedError",
      code: "recipient_not_approved",
    });
    expect(client.retryWithPayment).not.toHaveBeenCalled();

    const signerUnavailable = new ConsumerPaymentService({
      borrowerAccountId,
      authorizer: { authorize: vi.fn(async () => { throw new X402RequestError(503, "signer_unavailable", "down"); }) },
      clientFactory: () => client,
    });
    await expect(signerUnavailable.pay(prepared())).rejects.toBeInstanceOf(X402RequestError);
  });
});

describe("ConsumerMissionExecutor", () => {
  it("requests every lender and accepts the deterministically selected valid offer", async () => {
    const expensiveOffer = {
      ...offerTerms(),
      id: "offer-expensive",
      feeTinybar: 10n,
      termsHash: "b".repeat(64),
      signature,
    };
    const selectedOffer = {
      ...offerTerms(),
      id: "offer-selected",
      lenderAccountId: "0.0.2002",
      feeTinybar: 2n,
      termsHash: "c".repeat(64),
      signature,
    };
    const expensiveLender: ConsumerLender = {
      quote: vi.fn(async () => expensiveOffer),
      isOfferValid: vi.fn(() => true),
      accept: vi.fn(),
    };
    const selectedLender: ConsumerLender = {
      quote: vi.fn(async () => selectedOffer),
      isOfferValid: vi.fn(() => true),
      accept: vi.fn(async () => ({ fundingTxId })),
    };
    const signer: ConsumerCreditSigner = {
      signCreditRequest: vi.fn(async creditRequest => ({ ...creditRequest, signature })),
      signCreditAcceptance: vi.fn(async offer => signedAcceptance(offer)),
    };
    const payment: ConsumerPayment = {
      prepare: vi.fn(async () => prepared({ bundle })),
      pay: vi.fn(async () => paidResult),
    };
    const executor = new ConsumerMissionExecutor({
      borrowerAccountId,
      balance: { getBalanceTinybar: vi.fn(async () => 0n) },
      signer,
      lenders: [expensiveLender, selectedLender],
      payment,
      now: () => now,
      requestId: () => "credit-1",
    });

    const result = await executor.execute({
      missionId: "mission-1",
      targetRef: "ConsumerFlow.sol",
      source,
      maxBudgetTinybar: 1_000n,
      provider,
    });

    expect(expensiveLender.quote).toHaveBeenCalledTimes(1);
    expect(selectedLender.quote).toHaveBeenCalledTimes(1);
    expect(expensiveLender.quote).toHaveBeenCalledWith(expect.objectContaining({ requestedTermSeconds: 600 }));
    expect(result.credit?.offer).toBe(selectedOffer);
    expect(expensiveLender.accept).not.toHaveBeenCalled();
    expect(selectedLender.accept).toHaveBeenCalledTimes(1);
  });

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
      isOfferValid: vi.fn(() => true),
      accept: vi.fn(async () => {
        order.push("accept");
        attempts += 1;
        if (attempts < 3) throw new ConsumerServiceError(503, "settlement_unconfirmed", "registration pending");
        return { fundingTxId };
      }),
    };
    const payment: ConsumerPayment = {
      prepare: vi.fn(async (request, selected, missionPolicy) => {
        order.push("prepare");
        expect(request.targetSha256).toBe(targetSha256);
        expect(selected).toBe(provider);
        expect(missionPolicy).toEqual({ capTinybar: 1_000n, approvedRecipients: [provider.accountId] });
        return prepared({ bundle });
      }),
      pay: vi.fn(async ready => {
        order.push("pay");
        expect(ready.intent.nonce).toBe("7");
        expect(ready.bundle).toBe(bundle);
        return paidResult;
      }),
    };
    const executor = new ConsumerMissionExecutor({
      borrowerAccountId,
      balance: { getBalanceTinybar: vi.fn(async () => 1n) },
      signer,
      lenders: [lender],
      payment,
      now: () => now,
      requestId: () => "credit-1",
      fundingRetryDelayMs: 1,
      wait: vi.fn(async () => undefined),
    });
    const progress = vi.fn(async event => {
      order.push(event.type);
    });

    const result = await executor.execute({
      missionId: "mission-1",
      targetRef: "ConsumerFlow.sol",
      source,
      maxBudgetTinybar: 1_000n,
      provider,
    }, { onProgress: progress });

    // The whole payment is borrowed, not the shortfall: the principal must cover the bound intent.
    expect(result.credit?.request.principalTinybar).toBe(100n);
    expect(result.credit?.fundingTxId).toBe(fundingTxId);
    expect(order).toEqual([
      "prepare",
      "proof-generated",
      "sign-request",
      "credit-requested",
      "quote",
      "offers-received",
      "sign-acceptance",
      "accept",
      "accept",
      "accept",
      "funded",
      "payment-preparation",
      "pay",
    ]);
    expect(progress).toHaveBeenCalledTimes(5);
    expect(progress).toHaveBeenNthCalledWith(1, {
      type: "proof-generated",
      nonce: "7",
      publicSignals: bundle.publicSignals,
      vkeyHash: bundle.vkeyHash,
    });
    const evidence = { paymentIntent: paymentIntentWire(prepared().intent), paymentProofBundle: bundle };
    expect(signer.signCreditAcceptance).toHaveBeenCalledWith(creditOffer, evidence);
    expect(lender.accept).toHaveBeenCalledWith(acceptance, evidence);
    expect(evidence.paymentIntent).toEqual({
      amountTinybar: "100",
      recipientAccountId: provider.accountId,
      nonce: "7",
      resourceHash: prepared().intent.resourceHash,
      missionId: "mission-1",
    });
  });

  it("keeps the caller's evidence and emits no proof event in deterministic mode", async () => {
    const creditOffer = { ...offerTerms(), termsHash: "c".repeat(64), signature };
    const acceptance = signedAcceptance(creditOffer);
    const signer: ConsumerCreditSigner = {
      signCreditRequest: vi.fn(async creditRequest => ({ ...creditRequest, signature })),
      signCreditAcceptance: vi.fn(async () => acceptance),
    };
    const lender: ConsumerLender = {
      quote: vi.fn(async () => creditOffer),
      isOfferValid: vi.fn(() => true),
      accept: vi.fn(async () => ({ fundingTxId })),
    };
    const payment: ConsumerPayment = {
      prepare: vi.fn(async () => prepared()),
      pay: vi.fn(async () => paidResult),
    };
    const executor = new ConsumerMissionExecutor({
      borrowerAccountId,
      balance: { getBalanceTinybar: vi.fn(async () => 1n) },
      signer,
      lenders: [lender],
      payment,
      now: () => now,
      requestId: () => "credit-1",
    });
    const progress = vi.fn(async (_event: { type: string }) => undefined);

    await executor.execute({
      missionId: "mission-1",
      targetRef: "ConsumerFlow.sol",
      source,
      maxBudgetTinybar: 1_000n,
      provider,
    }, { onProgress: progress });

    expect(progress.mock.calls.map(([event]) => event.type)).toEqual([
      "credit-requested",
      "offers-received",
      "funded",
      "payment-preparation",
    ]);
    expect(signer.signCreditAcceptance).toHaveBeenCalledWith(creditOffer, {});
    expect(lender.accept).toHaveBeenCalledWith(acceptance, {});
  });

  it("surfaces a lender policy refusal of the bundle as a policy rejection", async () => {
    const creditOffer = { ...offerTerms(), termsHash: "c".repeat(64), signature };
    const signer: ConsumerCreditSigner = {
      signCreditRequest: vi.fn(async creditRequest => ({ ...creditRequest, signature })),
      signCreditAcceptance: vi.fn(async () => signedAcceptance(creditOffer)),
    };
    const lender: ConsumerLender = {
      quote: vi.fn(async () => creditOffer),
      isOfferValid: vi.fn(() => true),
      accept: vi.fn(async () => {
        throw new ConsumerServiceError(422, "proof_vkey_mismatch", "untrusted verification key");
      }),
    };
    const payment: ConsumerPayment = {
      prepare: vi.fn(async () => prepared({ bundle })),
      pay: vi.fn(),
    };
    const executor = new ConsumerMissionExecutor({
      borrowerAccountId,
      balance: { getBalanceTinybar: vi.fn(async () => 1n) },
      signer,
      lenders: [lender],
      payment,
      now: () => now,
    });

    await expect(executor.execute({
      missionId: "mission-1",
      targetRef: "ConsumerFlow.sol",
      source,
      maxBudgetTinybar: 1_000n,
      provider,
    })).rejects.toBeInstanceOf(ConsumerPolicyRejectedError);
    expect(payment.pay).not.toHaveBeenCalled();
  });

  it("pays without contacting credit services when the balance is sufficient", async () => {
    const signer = {
      signCreditRequest: vi.fn(),
      signCreditAcceptance: vi.fn(),
    } as unknown as ConsumerCreditSigner;
    const lender = { quote: vi.fn(), isOfferValid: vi.fn(), accept: vi.fn() } as unknown as ConsumerLender;
    const payment = { prepare: vi.fn(async () => prepared({ bundle })), pay: vi.fn(async () => paidResult) };
    const executor = new ConsumerMissionExecutor({
      borrowerAccountId,
      balance: { getBalanceTinybar: vi.fn(async () => 100n) },
      signer,
      lenders: [lender],
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
    expect(payment.prepare).toHaveBeenCalledTimes(1);
    expect(payment.pay).toHaveBeenCalledTimes(1);
  });
});
