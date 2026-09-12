import { createHash } from "node:crypto";
import type { Server } from "node:http";

import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements as SdkRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { inspectHederaTransaction } from "@x402/hedera";
import {
  buildCompletionCallback,
  buildReport,
  callbackSignature as providerCallbackSignature,
  createPaidScanServer,
  ProviderStore,
} from "@koven/resource-server";
import { createHttpPaymentAuthorizer, createPayingFetch, HttpX402Client, RemoteRestrictedSigner } from "@koven/x402";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { CompletionService } from "../src/completion.js";
import { CreditService } from "../src/credit.js";
import { PaymentGate } from "../src/gate.js";
import type { TransferConfirmer } from "../src/ledger.js";
import { RepaymentService } from "../src/repay.js";
import { createSignerApp } from "../src/server.js";
import type { SignerStore } from "../src/store.js";
import {
  consumerAccountId,
  consumerKey,
  credentials,
  feePayerAccountId,
  lenderAccountId,
  lenderCredential,
  lenderKey,
  memoryStore,
  poseidonHasher,
  policy,
  priceTinybar,
  providerAccountId,
  providerCallbackSecret,
} from "./helpers.js";

const settledAt = "2026-09-12T12:00:00.000Z";
const servers: Server[] = [];
const stores: SignerStore[] = [];
const providerStores: ProviderStore[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  stores.splice(0).forEach(store => store.close());
  providerStores.splice(0).forEach(store => store.close());
});

const listen = async (server: Server): Promise<string> => {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return `http://127.0.0.1:${address.port}`;
};

class FakeFacilitator implements FacilitatorClient {
  readonly verify = vi.fn(async (payload: PaymentPayload, _r: SdkRequirements): Promise<VerifyResponse> => ({
    isValid: true,
    payer: consumerAccountId,
    extra: { transactionId: inspectHederaTransaction(String(payload.payload.transaction)).transactionId },
  }));

  readonly settle = vi.fn(async (payload: PaymentPayload, _r: SdkRequirements): Promise<SettleResponse> => ({
    success: true,
    payer: consumerAccountId,
    transaction: inspectHederaTransaction(String(payload.payload.transaction)).transactionId,
    network: "hedera:testnet",
    amount: priceTinybar,
  }));

  async getSupported(): Promise<SupportedResponse> {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:testnet", extra: { feePayer: feePayerAccountId } }], extensions: [], signers: {} };
  }
}

let signerApp: (store: SignerStore, confirmer?: TransferConfirmer) => Promise<string>;
beforeAll(async () => {
  const poseidon = await poseidonHasher();
  signerApp = async (store, confirmer = { confirm: vi.fn(async () => ({ settledAt })) }) => listen(createSignerApp({
    store,
    gate: new PaymentGate({ store, accountId: consumerAccountId, privateKey: consumerKey, network: "hedera:testnet", poseidon }),
    credit: new CreditService({ store, accountId: consumerAccountId, privateKey: consumerKey, lenderPublicKeys: { [lenderAccountId]: lenderKey.publicKey.toStringRaw() }, confirmer }),
    completion: new CompletionService({ store, accountId: consumerAccountId, providerCallbackSecrets: { "provider-a": providerCallbackSecret }, confirmer }),
    repayment: new RepaymentService({ store, accountId: consumerAccountId, ledger: { prepare: vi.fn(), submit: vi.fn() }, confirmer }),
    credentials,
  }).listen(0, "127.0.0.1"));
});

const post = (baseUrl: string, path: string, body: unknown, token?: string) => fetch(`${baseUrl}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

/** A real F06 provider on a fixed port so its canonical scan URL is known in advance. */
async function provider() {
  const port = 4400 + Math.floor(Math.random() * 500);
  const endpoint = `http://127.0.0.1:${port}`;
  const facilitator = new FakeFacilitator();
  const store = new ProviderStore(":memory:");
  providerStores.push(store);
  const engine = { id: "test-engine", scan: vi.fn(async () => []) };
  const paidServer = await createPaidScanServer({
    providerId: "provider-a",
    providerAccountId,
    scanUrl: `${endpoint}/scan`,
    amountTinybar: priceTinybar,
    network: "hedera:testnet",
    asset: "0.0.0",
    signerPublicKeys: { [consumerAccountId]: consumerKey.publicKey.toStringRaw() },
    facilitatorUrl: "https://facilitator.example",
    facilitatorClient: facilitator,
    store,
    settlementConfirmer: { confirm: vi.fn(async () => ({ settledAt })) },
    callbackUrl: "http://127.0.0.1:3998/callbacks/mission-complete",
    callbackSecret: providerCallbackSecret,
    engine,
    dispatchCallbacks: false,
    reconcileSettlements: false,
  });
  await listen(paidServer.app.listen(port, "127.0.0.1"));
  return { endpoint, scanUrl: `${endpoint}/scan`, facilitator, engine, store };
}

describe("restricted signer HTTP surface", () => {
  it("reports health without a credential and enforces role credentials elsewhere", async () => {
    const store = memoryStore();
    stores.push(store);
    const baseUrl = await signerApp(store);

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", circuitId: "koven-policy-v1", vkeyHash: null });

    for (const [path, wrongToken] of [
      ["/authorize", credentials.orchestrator],
      ["/repay", credentials.consumer],
      ["/sign-credit-request", credentials.registrar],
      ["/sign-credit-acceptance", lenderCredential],
      ["/internal/missions/register", credentials.consumer],
      ["/internal/loans/register", credentials.registrar],
    ] as const) {
      const missing = await post(baseUrl, path, {});
      expect(missing.status, path).toBe(401);
      expect(await missing.json()).toMatchObject({ code: "auth_invalid" });
      const wrong = await post(baseUrl, path, {}, wrongToken);
      expect(wrong.status, path).toBe(401);
    }

    const malformed = await post(baseUrl, "/authorize", "{", credentials.consumer);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "request_invalid" });
    const invalid = await post(baseUrl, "/authorize", { missionId: "m" }, credentials.consumer);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "request_invalid" });
    const oversized = await post(baseUrl, "/authorize", JSON.stringify({ pad: "a".repeat(3 * 1024 * 1024) }), credentials.consumer);
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: "source_too_large" });
  });

  it("provisions policy for the registrar only, idempotently, and rejects conflicting replacements", async () => {
    const store = memoryStore();
    stores.push(store);
    const baseUrl = await signerApp(store);

    const consumerAttempt = await post(baseUrl, "/internal/missions/register", policy(), credentials.consumer);
    expect(consumerAttempt.status).toBe(401);
    const first = await post(baseUrl, "/internal/missions/register", policy(), credentials.registrar);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ missionId: "mission-1", status: "registered" });
    const retry = await post(baseUrl, "/internal/missions/register", policy(), credentials.registrar);
    expect(retry.status).toBe(200);
    const conflict = await post(baseUrl, "/internal/missions/register", policy("mission-1", { spendingCapTinybar: "9000000" }), credentials.registrar);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "mission_policy_conflict" });
    const raisedSession = await post(baseUrl, "/internal/missions/register", policy("mission-2", { sessionCapTinybar: "9000000" }), credentials.registrar);
    expect(raisedSession.status).toBe(409);
    expect(await raisedSession.json()).toMatchObject({ code: "mission_policy_conflict" });
  });

  it("pays a real F06 provider through the x402 client and then accepts the provider's completion", async () => {
    const source = "pragma solidity ^0.8.24; contract Paid {}";
    const sourceSha256 = createHash("sha256").update(source, "utf8").digest("hex");
    const { endpoint, scanUrl, facilitator, engine, store: providerStore } = await provider();
    const store = memoryStore();
    stores.push(store);
    const confirmer = { confirm: vi.fn(async () => ({ settledAt })) };
    const signerUrl = await signerApp(store, confirmer);
    const registered = await post(signerUrl, "/internal/missions/register", policy("mission-1", {
      targetSha256: sourceSha256,
      provider: { ...policy().provider, endpoint },
    }), credentials.registrar);
    expect(registered.status).toBe(200);

    // Keyless consumer: RemoteRestrictedSigner over the HTTP authorizer.
    const authorizer = createHttpPaymentAuthorizer({ baseUrl: signerUrl, credential: credentials.consumer });
    const signer = new RemoteRestrictedSigner(consumerAccountId, { missionId: "mission-1", targetSha256: sourceSha256, nonce: "1", scanUrl }, authorizer);
    const payingFetch = createPayingFetch(signer);
    const scanRequest = { missionId: "mission-1", targetRef: "Paid.sol", source, targetSha256: sourceSha256 };
    const response = await payingFetch(scanUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(scanRequest) });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(engine.scan).toHaveBeenCalledTimes(1);
    const report = await response.json() as { reportSha256: string };

    // The provider's stored payment is the transaction this signer authorized.
    const settlementTxId = [...providerStore.database.prepare("SELECT transaction_id FROM provider_paid_scans").all() as { transaction_id: string }[]][0]!.transaction_id;
    expect(store.getAuthorizationByTransactionId(settlementTxId)?.missionId).toBe("mission-1");

    // The orchestrator forwards the provider's raw callback unchanged.
    const stored = providerStore.getPayment(settlementTxId)!;
    const job = buildCompletionCallback(stored.report!, settlementTxId, settledAt);
    expect(stored.report!.reportSha256).toBe(report.reportSha256);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const forward = () => fetch(`${signerUrl}/internal/missions/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": job.idempotencyKey,
        "x-callback-timestamp": timestamp,
        "x-callback-signature": providerCallbackSignature(providerCallbackSecret, timestamp, job.idempotencyKey, job.body),
      },
      body: job.body,
    });
    const accepted = await forward();
    expect(accepted.status, await accepted.clone().text()).toBe(202);
    expect(await accepted.json()).toEqual({ status: "accepted" });
    expect(confirmer.confirm).toHaveBeenLastCalledWith({
      transactionId: settlementTxId,
      payerAccountId: consumerAccountId,
      recipientAccountId: providerAccountId,
      amountTinybar: 1_000_000n,
    });
    const replay = await forward();
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({ status: "duplicate", code: "callback_duplicate" });

    // The same signer also serves the orchestrator boundary via HttpX402Client.
    const client = new HttpX402Client({ scanUrl, now: () => settledAt });
    const nonce2 = new RemoteRestrictedSigner(consumerAccountId, { missionId: "mission-1", targetSha256: sourceSha256, nonce: "2", scanUrl }, authorizer);
    const challenge = await client.request(scanRequest);
    const transaction = await nonce2.createPartiallySignedTransferTransaction(challenge.requirements);
    const authorization = nonce2.authorizationFor(transaction)!;
    const paid = await client.retryWithPayment({ ...scanRequest, paymentAuthorization: { ...authorization, amountTinybar: BigInt(authorization.amountTinybar) } }, transaction);
    expect(paid.receipt.payer).toBe(consumerAccountId);
    expect(facilitator.settle).toHaveBeenCalledTimes(2);

    // A report the provider never produced for this mission is refused.
    const foreign = buildReport({ ...scanRequest, missionId: "mission-1" }, "provider-b", [], { startedAt: settledAt, completedAt: settledAt });
    const foreignJob = buildCompletionCallback(foreign, settlementTxId, settledAt);
    const refused = await fetch(`${signerUrl}/internal/missions/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": foreignJob.idempotencyKey,
        "x-callback-timestamp": timestamp,
        "x-callback-signature": providerCallbackSignature(providerCallbackSecret, timestamp, foreignJob.idempotencyKey, foreignJob.body),
      },
      body: foreignJob.body,
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "report_binding_mismatch" });
  });

  it("derives the lender identity from the credential on loan registration", async () => {
    const store = memoryStore();
    stores.push(store);
    const baseUrl = await signerApp(store);
    await post(baseUrl, "/internal/missions/register", policy(), credentials.registrar);
    const response = await post(baseUrl, "/internal/loans/register", {}, lenderCredential);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "request_invalid" });
  });
});
