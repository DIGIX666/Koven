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
} from "@x402/hedera";
import type { ScanRequest } from "@koven/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { authorizationSigningPayload } from "../src/authorization.js";
import type { CallbackDispatcher } from "../src/callback.js";
import { ProviderStore } from "../src/outbox.js";
import { hashSource } from "../src/request.js";
import type { ScanEngine } from "../src/scan.js";
import { createPaidScanServer, type PaidScanServerOptions } from "../src/server.js";
import { SettlementConfirmationError, type SettlementConfirmer } from "../src/settlement.js";

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
  readonly signerPrivateKey: PrivateKey;
}

const servers: Server[] = [];
const stores: ProviderStore[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
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
    ...overrides,
  });
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
    signerPrivateKey,
  };
}

async function challenge(baseUrl: string): Promise<PaymentRequirements> {
  const response = await fetch(`${baseUrl}/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(scanRequest),
  });
  expect(response.status).toBe(402);
  const header = response.headers.get("payment-required");
  expect(header).not.toBeNull();
  const required = decodePaymentRequiredHeader(header!);
  expect(required.accepts).toHaveLength(1);
  return required.accepts[0]!;
}

async function paidRequest(harness: Harness, request: ScanRequest = scanRequest) {
  const requirements = await challenge(harness.baseUrl);
  const payerKey = PrivateKey.generateECDSA();
  const clientSigner = createClientHederaSigner(consumerAccountId, payerKey, { network: "hedera:testnet" });
  const partial = await new ExactHederaScheme(clientSigner).createPaymentPayload(2, requirements);
  const paymentPayload: PaymentPayload = { ...partial, accepted: requirements };
  const transactionBase64 = String(paymentPayload.payload.transaction);
  const inspected = inspectHederaTransaction(transactionBase64);
  const authorization = {
    missionId: scanRequest.missionId,
    targetSha256: scanRequest.targetSha256,
    transactionSha256: createHash("sha256").update(Buffer.from(transactionBase64, "base64")).digest("hex"),
    transactionId: inspected.transactionId,
    borrowerAccountId: consumerAccountId,
    providerAccountId,
    scanUrl: "http://127.0.0.1:3999/scan",
    amountTinybar,
    network: "hedera:testnet" as const,
    asset: "0.0.0" as const,
    nonce: "1",
    expiresAt: "2099-01-01T00:00:00.000Z",
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

  it("retains an uncertain settlement and reconciles it without another settlement or scan", async () => {
    const pending = new SettlementConfirmationError("settlement_unconfirmed", 503, "Settlement is not yet visible");
    const confirmer = { confirm: vi.fn()
      .mockRejectedValueOnce(pending)
      .mockResolvedValueOnce({ settledAt: "2026-09-11T10:00:00.000Z" }) } as unknown as Harness["confirmer"];
    const harness = await createHarness({ settlementConfirmer: confirmer });
    const paid = await paidRequest(harness);
    const invoke = () => fetch(`${harness.baseUrl}/scan`, {
      method: "POST",
      headers: paid.headers,
      body: JSON.stringify(paid.body),
    });

    expect((await invoke()).status).toBe(503);
    expect((await invoke()).status).toBe(200);
    expect(harness.facilitator.settle).toHaveBeenCalledTimes(1);
    expect(harness.engine.scan).toHaveBeenCalledTimes(1);
    expect(confirmer.confirm).toHaveBeenCalledTimes(2);
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
    currentTime = new Date(currentTime.getTime() + 30_001);
    expect((await invoke()).status).toBe(200);
    expect(harness.engine.scan).toHaveBeenCalledTimes(1);
    expect(harness.facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("reconciles a persisted uncertain payment after the provider restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "koven-paid-scan-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "provider.db");
    const signerPrivateKey = PrivateKey.generateECDSA();
    const firstStore = new ProviderStore(databasePath);
    const firstConfirmer = {
      confirm: vi.fn(async () => {
        throw new SettlementConfirmationError("settlement_unconfirmed", 503, "Settlement is not yet visible");
      }),
    } as SettlementConfirmer;
    const first = await createHarness(
      { settlementConfirmer: firstConfirmer },
      { signerPrivateKey, store: firstStore },
    );
    const paid = await paidRequest(first);
    const firstResponse = await fetch(`${first.baseUrl}/scan`, {
      method: "POST",
      headers: paid.headers,
      body: JSON.stringify(paid.body),
    });
    expect(firstResponse.status).toBe(503);
    expect(first.facilitator.settle).toHaveBeenCalledTimes(1);

    await new Promise<void>(resolve => first.server.close(() => resolve()));
    servers.splice(servers.indexOf(first.server), 1);
    stores.splice(stores.indexOf(firstStore), 1);
    firstStore.close();
    const reopenedStore = new ProviderStore(databasePath);
    const second = await createHarness({}, { signerPrivateKey, store: reopenedStore });
    const recoveredResponse = await fetch(`${second.baseUrl}/scan`, {
      method: "POST",
      headers: paid.headers,
      body: JSON.stringify(paid.body),
    });

    expect(recoveredResponse.status).toBe(200);
    expect(second.facilitator.verify).not.toHaveBeenCalled();
    expect(second.facilitator.settle).not.toHaveBeenCalled();
    expect(second.engine.scan).not.toHaveBeenCalled();
    expect(reopenedStore.getPayment(paid.body.paymentAuthorization.transactionId)?.status).toBe("completed");
  });
});
