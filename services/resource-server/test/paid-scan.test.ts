import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FacilitatorClient } from "@x402/core/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import {
  createClientHederaSigner,
  ExactHederaScheme,
  inspectHederaTransaction,
  PrivateKey,
  Transaction,
} from "@x402/hedera";
import type { ScanRequest } from "@koven/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { authorizationSigningPayload } from "../src/authorization.js";
import type { CallbackDispatcher } from "../src/callback.js";
import { ProviderStore, SETTLEMENT_FAILURE_GRACE_MS } from "../src/outbox.js";
import { hashSource } from "../src/request.js";
import type { ScanEngine } from "../src/scan.js";
import { createPaidScanServer, type PaidScanServerOptions } from "../src/server.js";
import {
  SettlementConfirmationError,
  type SettlementConfirmer,
  type SettlementReconciliationWorker,
} from "../src/settlement.js";

const consumerAccountId = "0.0.1001";
const providerAccountId = "0.0.2001";
const feePayerAccountId = "0.0.3001";
const amountTinybar = "1000000";
const callbackSecret = Buffer.alloc(32, 7);
const source = "pragma solidity ^0.8.24; contract Paid {}";
const scanRequest: ScanRequest = {
  missionId: "mission-paid",
  targetRef: "Paid.sol",
  source,
  targetSha256: hashSource(source),
};

class FakeFacilitator implements FacilitatorClient {
  readonly verify = vi.fn(async (payload: PaymentPayload, _requirements: PaymentRequirements): Promise<VerifyResponse> => ({
    isValid: true,
    payer: consumerAccountId,
    extra: { transactionId: inspectHederaTransaction(String(payload.payload.transaction)).transactionId },
  }));

  readonly settle = vi.fn(async (payload: PaymentPayload, _requirements: PaymentRequirements): Promise<SettleResponse> => ({
    success: true,
    payer: consumerAccountId,
    transaction: inspectHederaTransaction(String(payload.payload.transaction)).transactionId,
    network: "hedera:testnet",
    amount: amountTinybar,
  }));

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [{
        x402Version: 2,
        scheme: "exact",
        network: "hedera:testnet",
        extra: { feePayer: feePayerAccountId },
      }],
      extensions: [],
      signers: {},
    };
  }
}

interface Harness {
  readonly baseUrl: string;
  readonly server: Server;
  readonly store: ProviderStore;
  readonly facilitator: FakeFacilitator;
  readonly engine: ScanEngine & { scan: ReturnType<typeof vi.fn> };
  readonly confirmer: SettlementConfirmer & { confirm: ReturnType<typeof vi.fn> };
  readonly callbackFetch: ReturnType<typeof vi.fn>;
  readonly callbacks: CallbackDispatcher;
  readonly settlements: SettlementReconciliationWorker;
  readonly signerPrivateKey: PrivateKey;
}

const servers: Server[] = [];
const stores: ProviderStore[] = [];
const temporaryDirectories: string[] = [];
const settlementWorkers: SettlementReconciliationWorker[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  settlementWorkers.splice(0).forEach(worker => worker.stop());
  stores.splice(0).forEach(store => store.close());
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

interface HarnessDependencies {
  readonly signerPrivateKey?: PrivateKey;
  readonly facilitator?: FakeFacilitator;
  readonly store?: ProviderStore;
}

async function createHarness(
  overrides: Partial<PaidScanServerOptions> = {},
  dependencies: HarnessDependencies = {},
): Promise<Harness> {
  const signerPrivateKey = dependencies.signerPrivateKey ?? PrivateKey.generateECDSA();
  const facilitator = dependencies.facilitator ?? new FakeFacilitator();
  const store = dependencies.store ?? new ProviderStore(":memory:");
  stores.push(store);
  const engine = {
    id: "test-engine",
    scan: vi.fn(async () => []),
  } as ScanEngine & { scan: ReturnType<typeof vi.fn> };
  const confirmer = {
    confirm: vi.fn(async () => ({ settledAt: "2026-09-11T10:00:00.000Z" })),
  } as SettlementConfirmer & { confirm: ReturnType<typeof vi.fn> };
  const callbackFetch = vi.fn(async () => new Response(JSON.stringify({ status: "accepted" }), {
    status: 202,
    headers: { "content-type": "application/json" },
  }));
  const paidServer = await createPaidScanServer({
    providerId: "provider-a",
    providerAccountId,
    scanUrl: "http://127.0.0.1:3999/scan",
    amountTinybar,
    network: "hedera:testnet",
    asset: "0.0.0",
    signerPublicKeys: { [consumerAccountId]: signerPrivateKey.publicKey.toStringRaw() },
    facilitatorUrl: "https://facilitator.example",
    facilitatorClient: facilitator,
    store,
    settlementConfirmer: confirmer,
    callbackUrl: "http://127.0.0.1:3998/callbacks/mission-complete",
    callbackSecret,
    callbackFetch,
    engine,
    dispatchCallbacks: false,
    reconcileSettlements: false,
    ...overrides,
  });
  settlementWorkers.push(paidServer.settlements);
  const server = paidServer.app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    store,
    facilitator,
    engine,
    confirmer,
    callbackFetch,
    callbacks: paidServer.callbacks,
    settlements: paidServer.settlements,
    signerPrivateKey,
  };
}

async function challenge(baseUrl: string, extraHeaders: Record<string, string> = {}): Promise<PaymentRequirements> {
  const response = await fetch(`${baseUrl}/scan`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(scanRequest),
  });
  expect(response.status).toBe(402);
  expect(await response.text()).toBe("");
  const header = response.headers.get("payment-required");
  expect(header).not.toBeNull();
  const required = decodePaymentRequiredHeader(header!);
  expect(required.accepts).toHaveLength(1);
  return required.accepts[0]!;
}

function authorizePayment(
  harness: Harness,
  request: ScanRequest,
  paymentPayload: PaymentPayload,
  expiresAt = "2099-01-01T00:00:00.000Z",
) {
  const transactionBase64 = String(paymentPayload.payload.transaction);
  const inspected = inspectHederaTransaction(transactionBase64);
  const authorization = {
    missionId: request.missionId,
    targetSha256: request.targetSha256,
    transactionSha256: createHash("sha256").update(Buffer.from(transactionBase64, "base64")).digest("hex"),
    transactionId: inspected.transactionId,
    borrowerAccountId: consumerAccountId,
    providerAccountId,
    scanUrl: "http://127.0.0.1:3999/scan",
    amountTinybar,
    network: "hedera:testnet" as const,
    asset: "0.0.0" as const,
    nonce: "1",
    expiresAt,
    signature: "0".repeat(128),
  };
  authorization.signature = Buffer.from(harness.signerPrivateKey.sign(
    Buffer.from(authorizationSigningPayload(authorization), "utf8"),
  )).toString("hex");

  return {
    body: { ...request, paymentAuthorization: authorization },
    paymentPayload,
    headers: {
      "content-type": "application/json",
      "payment-signature": encodePaymentSignatureHeader(paymentPayload),
    },
  };
}

async function paidRequest(
  harness: Harness,
  request: ScanRequest = scanRequest,
  expiresAt?: string,
) {
  const requirements = await challenge(harness.baseUrl);
  const payerKey = PrivateKey.generateECDSA();
  const clientSigner = createClientHederaSigner(consumerAccountId, payerKey, { network: "hedera:testnet" });
  const partial = await new ExactHederaScheme(clientSigner).createPaymentPayload(2, requirements);
  const paymentPayload: PaymentPayload = { ...partial, accepted: requirements };
  return authorizePayment(harness, request, paymentPayload, expiresAt);
}

describe("paid scan server", () => {
  it("returns exact HBAR payment requirements without calling the facilitator", async () => {
    const harness = await createHarness();
    const requirements = await challenge(harness.baseUrl);

    expect(requirements).toMatchObject({
      scheme: "exact",
      network: "hedera:testnet",
      asset: "0.0.0",
      amount: amountTinybar,
      payTo: providerAccountId,
      maxTimeoutSeconds: 180,
      extra: { feePayer: feePayerAccountId },
    });
    expect(harness.facilitator.verify).not.toHaveBeenCalled();
    expect(harness.facilitator.settle).not.toHaveBeenCalled();
  });

  it("answers the challenge with an empty body even for browser-like clients", async () => {
    const harness = await createHarness();
    const requirements = await challenge(harness.baseUrl, {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Mozilla/5.0",
    });

    expect(requirements.payTo).toBe(providerAccountId);
  });

  it("settles, independently confirms, persists and dispatches one bound scan", async () => {
    const harness = await createHarness();
    const paid = await paidRequest(harness);
    const response = await fetch(`${harness.baseUrl}/scan`, {
      method: "POST",
      headers: paid.headers,
      body: JSON.stringify(paid.body),
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("payment-response")).not.toBeNull();
    const report = await response.json() as { reportSha256: string };
    expect(report.reportSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(harness.facilitator.verify).toHaveBeenCalledTimes(1);
    expect(harness.facilitator.settle).toHaveBeenCalledTimes(1);
    expect(harness.engine.scan).toHaveBeenCalledTimes(1);
    expect(harness.confirmer.confirm).toHaveBeenCalledTimes(1);

    expect(harness.store.getPayment(paid.body.paymentAuthorization.transactionId)?.status).toBe("completed");
    expect(harness.callbackFetch).not.toHaveBeenCalled();
    expect(await harness.callbacks.dispatchDue()).toBe(1);
    expect(harness.callbackFetch).toHaveBeenCalledTimes(1);
  });

  it("returns the stored report for an identical retry without settling or scanning twice", async () => {
    const harness = await createHarness();
    const paid = await paidRequest(harness);
    const invoke = () => fetch(`${harness.baseUrl}/scan`, {
      method: "POST",
      headers: paid.headers,
      body: JSON.stringify(paid.body),
    });

    const first = await invoke();
    const second = await invoke();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(harness.facilitator.settle).toHaveBeenCalledTimes(1);
    expect(harness.engine.scan).toHaveBeenCalledTimes(1);
  });

  it("rejects source and authorization substitution before verification, settlement or scanning", async () => {
    const harness = await createHarness();
    const paid = await paidRequest(harness);
    const alteredSource = `${source}\n`;
    const response = await fetch(`${harness.baseUrl}/scan`, {
      method: "POST",
      headers: paid.headers,
      body: JSON.stringify({
        ...paid.body,
        source: alteredSource,
        targetSha256: hashSource(alteredSource),
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "payment_authorization_mismatch" });
    expect(harness.facilitator.verify).not.toHaveBeenCalled();
    expect(harness.facilitator.settle).not.toHaveBeenCalled();
    expect(harness.engine.scan).not.toHaveBeenCalled();
  });

  it("rejects substituted transaction bytes before facilitator verification", async () => {
    const harness = await createHarness();
    const authorized = await paidRequest(harness);
    const substituted = await paidRequest(harness);
    const response = await fetch(`${harness.baseUrl}/scan`, {
      method: "POST",
      headers: substituted.headers,
      body: JSON.stringify(authorized.body),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "payment_authorization_mismatch" });
    expect(harness.facilitator.verify).not.toHaveBeenCalled();
    expect(harness.facilitator.settle).not.toHaveBeenCalled();
    expect(harness.engine.scan).not.toHaveBeenCalled();
  });

  it("rejects an untrusted authorization signature and a new expired authorization", async () => {
    const currentTime = new Date("2026-09-11T10:00:00.000Z");
    const harness = await createHarness({ now: () => currentTime });
    const untrusted = await paidRequest(harness);
    const untrustedResponse = await fetch(`${harness.baseUrl}/scan`, {
      method: "POST",
      headers: untrusted.headers,
      body: JSON.stringify({
        ...untrusted.body,
        paymentAuthorization: { ...untrusted.body.paymentAuthorization, signature: "0".repeat(128) },
      }),
    });
    const expired = await paidRequest(harness, scanRequest, "2026-09-11T09:59:59.000Z");
    const expiredResponse = await fetch(`${harness.baseUrl}/scan`, {
      method: "POST",
      headers: expired.headers,
      body: JSON.stringify(expired.body),
    });

    expect(untrustedResponse.status).toBe(401);
    expect(expiredResponse.status).toBe(401);
    expect(harness.facilitator.verify).not.toHaveBeenCalled();
    expect(harness.facilitator.settle).not.toHaveBeenCalled();
    expect(harness.engine.scan).not.toHaveBeenCalled();
  });

  it("rejects payment requirements without the trusted facilitator fee payer", async () => {
    const harness = await createHarness();
    const paid = await paidRequest(harness);
    const incompletePayload: PaymentPayload = {
      ...paid.paymentPayload,
      accepted: {
        ...paid.paymentPayload.accepted,
        extra: undefined,
      } as unknown as PaymentRequirements,
    };
    const response = await fetch(`${harness.baseUrl}/scan`, {
      method: "POST",
      headers: {
        ...paid.headers,
        "payment-signature": encodePaymentSignatureHeader(incompletePayload),
      },
      body: JSON.stringify(paid.body),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "payment_authorization_mismatch" });
    expect(harness.facilitator.verify).not.toHaveBeenCalled();
  });

  it("rejects a fee payer that differs from the facilitator-supported account", async () => {
    const harness = await createHarness();
    const paid = await paidRequest(harness);
    const forgedPayload: PaymentPayload = {
      ...paid.paymentPayload,
      accepted: {
        ...paid.paymentPayload.accepted,
        extra: { ...paid.paymentPayload.accepted.extra, feePayer: "0.0.4001" },
      },
    };
    const response = await fetch(`${harness.baseUrl}/scan`, {
      method: "POST",
      headers: {
        ...paid.headers,
        "payment-signature": encodePaymentSignatureHeader(forgedPayload),
      },
      body: JSON.stringify(paid.body),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "payment_authorization_mismatch" });
    expect(harness.facilitator.verify).not.toHaveBeenCalled();
    expect(harness.facilitator.settle).not.toHaveBeenCalled();
    expect(harness.engine.scan).not.toHaveBeenCalled();
  });

  it("allows only one concurrent request to settle and scan a transaction", async () => {
    const harness = await createHarness();
    const paid = await paidRequest(harness);
    const transactionId = paid.body.paymentAuthorization.transactionId;
    let finishSettlement!: (value: SettleResponse) => void;
    let ledgerConfirmed = false;
    harness.facilitator.settle.mockImplementationOnce(async () => new Promise(resolve => {
      finishSettlement = resolve;
    }));
    harness.confirmer.confirm.mockImplementation(async () => {
      if (!ledgerConfirmed) {
        throw new SettlementConfirmationError("settlement_unconfirmed", 503, "Settlement is not yet visible");
      }
      return { settledAt: "2026-09-11T10:00:00.000Z" };
    });
    const invoke = () => fetch(`${harness.baseUrl}/scan`, {
      method: "POST",
      headers: paid.headers,
      body: JSON.stringify(paid.body),
    });

    const first = invoke();
    await vi.waitFor(() => expect(harness.facilitator.settle).toHaveBeenCalledTimes(1));
    const concurrent = await invoke();
    expect(concurrent.status).toBe(503);
    ledgerConfirmed = true;
    finishSettlement({
      success: true,
      payer: consumerAccountId,
      transaction: transactionId,
      network: "hedera:testnet",
      amount: amountTinybar,
    });
    expect((await first).status).toBe(200);
    expect(harness.facilitator.settle).toHaveBeenCalledTimes(1);
    expect(harness.engine.scan).toHaveBeenCalledTimes(1);
  });

  it("does not scan with a lease that another request acquired during verification", async () => {
    let currentTime = new Date("2026-09-11T10:00:00.000Z");
    const harness = await createHarness({ now: () => currentTime });
    const paid = await paidRequest(harness);
    let finishVerification!: (value: VerifyResponse) => void;
    harness.facilitator.verify.mockImplementationOnce(async () => new Promise(resolve => {
      finishVerification = resolve;
    }));
    const invoke = () => fetch(`${harness.baseUrl}/scan`, {
      method: "POST",
      headers: paid.headers,
      body: JSON.stringify(paid.body),
    });

    const first = invoke();
    await vi.waitFor(() => expect(harness.facilitator.verify).toHaveBeenCalledTimes(1));
    currentTime = new Date(currentTime.getTime() + 30_001);
    const second = await invoke();
    expect(second.status).toBe(200);
    finishVerification({
      isValid: true,
      payer: consumerAccountId,
      extra: { transactionId: paid.body.paymentAuthorization.transactionId },
    });
    expect((await first).status).toBe(503);
    expect(harness.facilitator.settle).toHaveBeenCalledTimes(1);
    expect(harness.engine.scan).toHaveBeenCalledTimes(1);
  });

  it("rejects conflicting reuse of a transaction without a second settlement or scan", async () => {
    const harness = await createHarness();
    const paid = await paidRequest(harness);
    const first = await fetch(`${harness.baseUrl}/scan`, {
      method: "POST",
      headers: paid.headers,
      body: JSON.stringify(paid.body),
    });
    const otherSource = "pragma solidity ^0.8.24; contract Other {}";
    const otherRequest: ScanRequest = {
      missionId: "mission-other",
      targetRef: "Other.sol",
      source: otherSource,
      targetSha256: hashSource(otherSource),
    };
    const conflicting = authorizePayment(harness, otherRequest, paid.paymentPayload);
    const second = await fetch(`${harness.baseUrl}/scan`, {
      method: "POST",
      headers: conflicting.headers,
      body: JSON.stringify(conflicting.body),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: "idempotency_conflict" });
    expect(harness.facilitator.settle).toHaveBeenCalledTimes(1);
    expect(harness.engine.scan).toHaveBeenCalledTimes(1);
  });

  it("delivers a facilitator-confirmed report while Mirror lags and gates only the callback", async () => {
    const pending = new SettlementConfirmationError("settlement_unconfirmed", 503, "Settlement is not yet visible");
    const confirmer = { confirm: vi.fn()
      .mockRejectedValueOnce(pending)
      .mockResolvedValueOnce({ settledAt: "2026-09-11T10:00:00.000Z" }) } as unknown as Harness["confirmer"];
    const harness = await createHarness({ settlementConfirmer: confirmer });
    const paid = await paidRequest(harness);
    const transactionId = paid.body.paymentAuthorization.transactionId;
    const invoke = () => fetch(`${harness.baseUrl}/scan`, {
      method: "POST",
      headers: paid.headers,
      body: JSON.stringify(paid.body),
    });

    const first = await invoke();
    expect(first.status).toBe(200);
    expect(first.headers.get("payment-response")).not.toBeNull();
    expect(harness.store.getPayment(transactionId)?.status).toBe("settled");
    expect(await harness.callbacks.dispatchDue()).toBe(0);
    expect(harness.callbackFetch).not.toHaveBeenCalled();

    const second = await invoke();
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(harness.store.getPayment(transactionId)?.status).toBe("completed");
    expect(await harness.callbacks.dispatchDue()).toBe(1);
    expect(harness.facilitator.settle).toHaveBeenCalledTimes(1);
    expect(harness.engine.scan).toHaveBeenCalledTimes(1);
    expect(confirmer.confirm).toHaveBeenCalledTimes(2);
  });

  it("withholds the report while the facilitator outcome is unknown and completes from the ledger", async () => {
    const harness = await createHarness();
    harness.facilitator.settle.mockRejectedValueOnce(new Error("facilitator timeout"));
    harness.confirmer.confirm
      .mockRejectedValueOnce(new SettlementConfirmationError("settlement_unconfirmed", 503, "Settlement is not yet visible"))
      .mockResolvedValueOnce({ settledAt: "2026-09-11T10:00:00.000Z" });
    const paid = await paidRequest(harness);
    const transactionId = paid.body.paymentAuthorization.transactionId;
    const invoke = () => fetch(`${harness.baseUrl}/scan`, {
      method: "POST",
      headers: paid.headers,
      body: JSON.stringify(paid.body),
    });

    const first = await invoke();
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({ code: "settlement_unconfirmed" });
    expect(harness.store.getPayment(transactionId)).toMatchObject({
      status: "report_ready",
      settlementAttempted: true,
      lastError: "Facilitator did not confirm settlement: facilitator timeout",
    });
    expect(harness.confirmer.confirm).not.toHaveBeenCalled();

    const retry = await invoke();
    expect(retry.status).toBe(503);
    expect(await retry.json()).toMatchObject({ code: "settlement_unconfirmed" });
    expect(harness.store.getPayment(transactionId)?.lastError).toBe("Settlement is not yet visible");
    expect(await harness.callbacks.dispatchDue()).toBe(0);

    const confirmed = await invoke();
    expect(confirmed.status).toBe(200);
    expect(confirmed.headers.get("payment-response")).not.toBeNull();
    expect(harness.store.getPayment(transactionId)?.status).toBe("completed");
    expect(await harness.callbacks.dispatchDue()).toBe(1);
    expect(harness.facilitator.settle).toHaveBeenCalledTimes(1);
    expect(harness.engine.scan).toHaveBeenCalledTimes(1);
  });

  it("keeps a facilitator refusal reconcilable, rotates it behind newer rows, then fails it after the transaction window", async () => {
    let currentTime = new Date("2026-09-11T10:00:00.000Z");
    const harness = await createHarness({ now: () => currentTime });
    harness.facilitator.settle.mockResolvedValueOnce({
      success: false,
      errorReason: "insufficient_funds",
      transaction: "",
      network: "hedera:testnet",
      payer: consumerAccountId,
    });
    harness.confirmer.confirm.mockImplementation(async () => {
      throw new SettlementConfirmationError("settlement_unconfirmed", 503, "Settlement is not yet visible");
    });
    const declined = await paidRequest(harness);
    const declinedId = declined.body.paymentAuthorization.transactionId;
    const invoke = (paid: typeof declined) => fetch(`${harness.baseUrl}/scan`, {
      method: "POST",
      headers: paid.headers,
      body: JSON.stringify(paid.body),
    });

    const refused = await invoke(declined);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ code: "settlement_unconfirmed" });
    const stored = harness.store.getPayment(declinedId)!;
    expect(stored).toMatchObject({ status: "report_ready", settlementAttempted: true, settlement: null });
    expect(stored.lastError).toBe("Facilitator did not confirm settlement: insufficient_funds");
    const transaction = Transaction.fromBytes(Buffer.from(String(declined.paymentPayload.payload.transaction), "base64"));
    expect(stored.validUntil).toBe(
      transaction.transactionId!.validStart!.toDate().getTime() + (transaction.transactionValidDuration * 1000),
    );

    // A second uncertain payment must not starve behind the refused one.
    currentTime = new Date(currentTime.getTime() + 1_000);
    const later = await paidRequest(harness);
    const laterId = later.body.paymentAuthorization.transactionId;
    expect((await invoke(later)).status).toBe(200);
    expect(harness.store.pendingSettlements(1).map(payment => payment.transactionId)).toEqual([declinedId]);
    currentTime = new Date(currentTime.getTime() + 1_000);
    expect(await harness.settlements.dispatchDue(1)).toBe(1);
    expect(harness.store.pendingSettlements(1).map(payment => payment.transactionId)).toEqual([laterId]);

    // Before the transaction window and Mirror grace elapse, the refusal stays reconcilable.
    currentTime = new Date(stored.validUntil + SETTLEMENT_FAILURE_GRACE_MS);
    await harness.settlements.dispatchDue();
    expect(harness.store.getPayment(declinedId)?.status).toBe("report_ready");

    currentTime = new Date(stored.validUntil + SETTLEMENT_FAILURE_GRACE_MS + 1);
    await harness.settlements.dispatchDue();
    expect(harness.store.getPayment(declinedId)?.status).toBe("settlement_failed");
    expect(harness.store.pendingSettlements().map(payment => payment.transactionId)).toEqual([laterId]);

    const retry = await invoke(declined);
    expect(retry.status).toBe(401);
    expect(await retry.json()).toMatchObject({ code: "payment_authorization_invalid" });
    expect(await harness.callbacks.dispatchDue()).toBe(0);
    expect(harness.facilitator.settle).toHaveBeenCalledTimes(2);
    expect(harness.engine.scan).toHaveBeenCalledTimes(2);
  });

  it("never marks a facilitator-confirmed settlement as failed while Mirror stays silent", async () => {
    let currentTime = new Date("2026-09-11T10:00:00.000Z");
    const harness = await createHarness({ now: () => currentTime });
    harness.confirmer.confirm.mockImplementation(async () => {
      throw new SettlementConfirmationError("settlement_unconfirmed", 503, "Settlement is not yet visible");
    });
    const paid = await paidRequest(harness);
    const transactionId = paid.body.paymentAuthorization.transactionId;
    expect((await fetch(`${harness.baseUrl}/scan`, {
      method: "POST",
      headers: paid.headers,
      body: JSON.stringify(paid.body),
    })).status).toBe(200);

    currentTime = new Date(harness.store.getPayment(transactionId)!.validUntil + SETTLEMENT_FAILURE_GRACE_MS + 86_400_000);
    await harness.settlements.dispatchDue();
    expect(harness.store.getPayment(transactionId)?.status).toBe("settled");
    expect(harness.store.pendingSettlements().map(payment => payment.transactionId)).toEqual([transactionId]);
  });

  it("rotates a ledger mismatch behind newer rows without ever failing it automatically", async () => {
    let currentTime = new Date("2026-09-11T10:00:00.000Z");
    const harness = await createHarness({ now: () => currentTime });
    harness.facilitator.settle.mockRejectedValueOnce(new Error("facilitator timeout"));
    harness.confirmer.confirm.mockImplementation(async () => {
      throw new SettlementConfirmationError("payment_authorization_mismatch", 403, "Settlement does not match the authorized payment");
    });
    const mismatched = await paidRequest(harness);
    const mismatchedId = mismatched.body.paymentAuthorization.transactionId;
    expect((await fetch(`${harness.baseUrl}/scan`, {
      method: "POST",
      headers: mismatched.headers,
      body: JSON.stringify(mismatched.body),
    })).status).toBe(503);

    currentTime = new Date(currentTime.getTime() + 1_000);
    harness.facilitator.settle.mockRejectedValueOnce(new Error("facilitator timeout"));
    const later = await paidRequest(harness);
    const laterId = later.body.paymentAuthorization.transactionId;
    expect((await fetch(`${harness.baseUrl}/scan`, {
      method: "POST",
      headers: later.headers,
      body: JSON.stringify(later.body),
    })).status).toBe(503);

    expect(harness.store.pendingSettlements(1).map(payment => payment.transactionId)).toEqual([mismatchedId]);
    currentTime = new Date(harness.store.getPayment(mismatchedId)!.validUntil + SETTLEMENT_FAILURE_GRACE_MS + 1);
    expect(await harness.settlements.dispatchDue(1)).toBe(1);
    expect(harness.store.getPayment(mismatchedId)).toMatchObject({
      status: "report_ready",
      lastError: "Settlement does not match the authorized payment",
    });
    expect(harness.store.pendingSettlements(1).map(payment => payment.transactionId)).toEqual([laterId]);
  });

  it("fails explicitly instead of truncating a scan that exceeds the report contract", async () => {
    const harness = await createHarness();
    harness.engine.scan.mockImplementationOnce(async () => Array.from({ length: 1001 }, (_, index) => ({
      ruleId: "not-rely-on-time",
      severity: "low",
      file: "Paid.sol",
      line: index + 1,
      message: "Avoid time-based decisions",
    })));
    const paid = await paidRequest(harness);
    const response = await fetch(`${harness.baseUrl}/scan`, {
      method: "POST",
      headers: paid.headers,
      body: JSON.stringify(paid.body),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "internal_error",
      detail: "Scan produced 1001 findings; the report contract allows at most 1000",
    });
    expect(harness.facilitator.settle).not.toHaveBeenCalled();
    expect(harness.store.getPayment(paid.body.paymentAuthorization.transactionId)?.report).toBeNull();
  });

  it("reconciles an already-attempted payment even after its authorization expires", async () => {
    let currentTime = new Date("2026-09-11T10:00:00.000Z");
    const pending = new SettlementConfirmationError("settlement_unconfirmed", 503, "Settlement is not yet visible");
    const confirmer = { confirm: vi.fn()
      .mockRejectedValueOnce(pending)
      .mockResolvedValueOnce({ settledAt: "2026-09-11T10:00:01.000Z" }) } as unknown as Harness["confirmer"];
    const harness = await createHarness({ settlementConfirmer: confirmer, now: () => currentTime });
    const paid = await paidRequest(harness, scanRequest, "2026-09-11T10:00:01.000Z");
    const invoke = () => fetch(`${harness.baseUrl}/scan`, {
      method: "POST",
      headers: paid.headers,
      body: JSON.stringify(paid.body),
    });

    expect((await invoke()).status).toBe(200);
    expect(harness.store.getPayment(paid.body.paymentAuthorization.transactionId)?.status).toBe("settled");
    currentTime = new Date("2026-09-11T10:00:02.000Z");
    expect((await invoke()).status).toBe(200);
    expect(harness.store.getPayment(paid.body.paymentAuthorization.transactionId)?.status).toBe("completed");
    expect(harness.facilitator.settle).toHaveBeenCalledTimes(1);
    expect(harness.engine.scan).toHaveBeenCalledTimes(1);
  });

  it("returns a typed client error for malformed JSON", async () => {
    const harness = await createHarness();
    const response = await fetch(`${harness.baseUrl}/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "request_invalid",
      detail: "Request body is not valid JSON",
    });
  });

  it("reuses a persisted report when an expired processing lease is recovered", async () => {
    const store = new ProviderStore(":memory:");
    let currentTime = new Date("2026-09-11T10:00:00.000Z");
    const harness = await createHarness({
      store,
      now: () => currentTime,
    }, { store });
    const originalMarkSettlementAttempted = store.markSettlementAttempted.bind(store);
    vi.spyOn(store, "markSettlementAttempted")
      .mockImplementationOnce(() => {
        throw new Error("simulated process interruption");
      })
      .mockImplementation(originalMarkSettlementAttempted);
    const paid = await paidRequest(harness);
    const invoke = () => fetch(`${harness.baseUrl}/scan`, {
      method: "POST",
      headers: paid.headers,
      body: JSON.stringify(paid.body),
    });

    expect((await invoke()).status).toBe(500);
    expect(store.getPayment(paid.body.paymentAuthorization.transactionId)?.status).toBe("report_ready");
    currentTime = new Date(currentTime.getTime() + 300_001);
    expect((await invoke()).status).toBe(200);
    expect(harness.engine.scan).toHaveBeenCalledTimes(1);
    expect(harness.facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("reconciles a persisted uncertain payment automatically after the provider restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "koven-paid-scan-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "provider.db");
    const signerPrivateKey = PrivateKey.generateECDSA();
    let currentTime = new Date("2026-09-11T10:00:00.000Z");
    const firstStore = new ProviderStore(databasePath);
    const firstConfirmer = {
      confirm: vi.fn(async () => {
        throw new SettlementConfirmationError("settlement_unconfirmed", 503, "Settlement is not yet visible");
      }),
    } as SettlementConfirmer;
    const first = await createHarness(
      { settlementConfirmer: firstConfirmer, now: () => currentTime },
      { signerPrivateKey, store: firstStore },
    );
    first.facilitator.settle.mockRejectedValueOnce(new Error("facilitator connection lost"));
    const paid = await paidRequest(first, scanRequest, "2026-09-11T10:00:01.000Z");
    const firstResponse = await fetch(`${first.baseUrl}/scan`, {
      method: "POST",
      headers: paid.headers,
      body: JSON.stringify(paid.body),
    });
    expect(firstResponse.status).toBe(503);
    expect(first.facilitator.settle).toHaveBeenCalledTimes(1);
    expect(firstStore.getPayment(paid.body.paymentAuthorization.transactionId)).toMatchObject({
      status: "report_ready",
      settlementAttempted: true,
      settlement: null,
    });

    await new Promise<void>(resolve => first.server.close(() => resolve()));
    servers.splice(servers.indexOf(first.server), 1);
    stores.splice(stores.indexOf(firstStore), 1);
    firstStore.close();
    const reopenedStore = new ProviderStore(databasePath);
    currentTime = new Date("2026-09-11T10:00:02.000Z");
    const second = await createHarness({
      now: () => currentTime,
      reconcileSettlements: true,
      settlementReconcileIntervalMs: 10,
    }, { signerPrivateKey, store: reopenedStore });

    await vi.waitFor(() => {
      expect(reopenedStore.getPayment(paid.body.paymentAuthorization.transactionId)?.status).toBe("completed");
    });
    expect(second.facilitator.verify).not.toHaveBeenCalled();
    expect(second.facilitator.settle).not.toHaveBeenCalled();
    expect(second.engine.scan).not.toHaveBeenCalled();
    expect(await second.callbacks.dispatchDue()).toBe(1);
  });
});
