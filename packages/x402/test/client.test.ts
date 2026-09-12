import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements as SdkRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { createClientHederaSigner, inspectHederaTransaction, PrivateKey } from "@x402/hedera";
import type { PaymentRequirements, ScanRequest } from "@koven/domain";
import {
  authorizationSigningPayload,
  createPaidScanServer,
  ProviderStore,
  type SettlementConfirmer,
} from "@koven/resource-server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChallengeRejectedError } from "../src/challenge.js";
import {
  type AuthorizeRequest,
  type AuthorizeResponse,
  createHttpPaymentAuthorizer,
  createPayingFetch,
  HttpX402Client,
  type PaymentAuthorizer,
  RemoteRestrictedSigner,
  X402RequestError,
} from "../src/client.js";

const consumerAccountId = "0.0.1001";
const providerAccountId = "0.0.2001";
const feePayerAccountId = "0.0.3001";
const amountTinybar = "1000000";
const source = "pragma solidity ^0.8.24; contract Paid {}";
const targetSha256 = createHash("sha256").update(source, "utf8").digest("hex");
const scanRequest: ScanRequest = { missionId: "mission-paid", targetRef: "Paid.sol", source, targetSha256 };
const otherMission: ScanRequest = { ...scanRequest, missionId: "mission-other" };
const observedAt = "2026-09-12T10:00:00.000Z";

class FakeFacilitator implements FacilitatorClient {
  readonly verify = vi.fn(async (payload: PaymentPayload, _requirements: SdkRequirements): Promise<VerifyResponse> => ({
    isValid: true,
    payer: consumerAccountId,
    extra: { transactionId: inspectHederaTransaction(String(payload.payload.transaction)).transactionId },
  }));

  readonly settle = vi.fn(async (payload: PaymentPayload, _requirements: SdkRequirements): Promise<SettleResponse> => ({
    success: true,
    payer: consumerAccountId,
    transaction: inspectHederaTransaction(String(payload.payload.transaction)).transactionId,
    network: "hedera:testnet",
    amount: amountTinybar,
  }));

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:testnet", extra: { feePayer: feePayerAccountId } }],
      extensions: [],
      signers: {},
    };
  }
}

/**
 * Emulates the restricted signer's `/authorize` (A2.4): builds the partially
 * signed transfer with the real Hedera SDK and signs the authorization over the
 * exact returned bytes, the way the provider verifies it.
 */
class EmulatedSigner implements PaymentAuthorizer {
  readonly calls: AuthorizeRequest[] = [];
  private readonly payerKey = PrivateKey.generateECDSA();
  tamper: ((response: AuthorizeResponse) => AuthorizeResponse) | undefined;

  constructor(
    private readonly scanUrl: string,
    readonly signingKey: PrivateKey = PrivateKey.generateECDSA(),
    private readonly mission: { targetSha256: string } = scanRequest,
  ) {}

  async authorize(request: AuthorizeRequest): Promise<AuthorizeResponse> {
    this.calls.push(request);
    const signer = createClientHederaSigner(consumerAccountId, this.payerKey, { network: "hedera:testnet" });
    const transaction = await signer.createPartiallySignedTransferTransaction(request.requirements);
    const bytes = Buffer.from(transaction, "base64");
    const authorization = {
      missionId: request.missionId,
      targetSha256: this.mission.targetSha256,
      transactionSha256: createHash("sha256").update(bytes).digest("hex"),
      transactionId: inspectHederaTransaction(transaction).transactionId,
      borrowerAccountId: consumerAccountId,
      providerAccountId: request.requirements.payTo,
      scanUrl: this.scanUrl,
      amountTinybar: request.requirements.amount,
      network: "hedera:testnet" as const,
      asset: "0.0.0" as const,
      nonce: request.nonce,
      expiresAt: "2099-01-01T00:00:00.000Z",
      signature: "0".repeat(128),
    };
    authorization.signature = Buffer.from(
      this.signingKey.sign(Buffer.from(authorizationSigningPayload(authorization), "utf8")),
    ).toString("hex");
    const response = { transaction, paymentAuthorization: authorization };
    return this.tamper ? this.tamper(response) : response;
  }
}

const servers: Server[] = [];
const stores: ProviderStore[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  stores.splice(0).forEach(store => store.close());
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

/** A real F06 provider, on a fixed port so its canonical scan URL is known before it listens. */
async function provider() {
  const signingKey = PrivateKey.generateECDSA();
  const port = 4400 + Math.floor(Math.random() * 500);
  const scanUrl = `http://127.0.0.1:${port}/scan`;
  const facilitator = new FakeFacilitator();
  const store = new ProviderStore(":memory:");
  stores.push(store);
  const engine = { id: "test-engine", scan: vi.fn(async () => []) };
  const confirmer: SettlementConfirmer = { confirm: vi.fn(async () => ({ settledAt: observedAt })) };
  const paidServer = await createPaidScanServer({
    providerId: "provider-a",
    providerAccountId,
    scanUrl,
    amountTinybar,
    network: "hedera:testnet",
    asset: "0.0.0",
    signerPublicKeys: { [consumerAccountId]: signingKey.publicKey.toStringRaw() },
    facilitatorUrl: "https://facilitator.example",
    facilitatorClient: facilitator,
    store,
    settlementConfirmer: confirmer,
    callbackUrl: "http://127.0.0.1:3998/callbacks/mission-complete",
    callbackSecret: Buffer.alloc(32, 7),
    engine,
    dispatchCallbacks: false,
    reconcileSettlements: false,
  });
  const baseUrl = await listen(paidServer.app.listen(port, "127.0.0.1"));
  expect(`${baseUrl}/scan`).toBe(scanUrl);
  return { scanUrl, facilitator, engine, store, authorizer: new EmulatedSigner(scanUrl, signingKey) };
}

const signerFor = (authorizer: EmulatedSigner, scanUrl: string, mission: ScanRequest = scanRequest, nonce = "1") => (
  new RemoteRestrictedSigner(consumerAccountId, {
    missionId: mission.missionId,
    targetSha256: mission.targetSha256,
    nonce,
    scanUrl,
  }, authorizer)
);

describe("paying fetch against the real provider", () => {
  it("pays the 402 challenge once and receives the settled report", async () => {
    const { scanUrl, facilitator, engine, authorizer } = await provider();
    const payingFetch = createPayingFetch(signerFor(authorizer, scanUrl));

    const response = await payingFetch(scanUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(scanRequest),
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("payment-response")).not.toBeNull();
    const report = await response.json() as { missionId: string; targetSha256: string };
    expect(report).toMatchObject({ missionId: scanRequest.missionId, targetSha256 });
    expect(authorizer.calls).toHaveLength(1);
    expect(authorizer.calls[0]).toMatchObject({ missionId: scanRequest.missionId, nonce: "1" });
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(engine.scan).toHaveBeenCalledTimes(1);
  });

  it("passes non-402 responses through untouched", async () => {
    const { scanUrl, authorizer } = await provider();
    const payingFetch = createPayingFetch(signerFor(authorizer, scanUrl));

    const response = await payingFetch(scanUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...scanRequest, source: `${source} ` }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "source_hash_mismatch" });
    expect(authorizer.calls).toHaveLength(0);
  });

  it("never contacts the signer for another mission or another URL", async () => {
    const { scanUrl, authorizer } = await provider();
    const payingFetch = createPayingFetch(signerFor(authorizer, scanUrl));
    const init = { method: "POST", headers: { "content-type": "application/json" } };

    await expect(payingFetch(scanUrl, { ...init, body: JSON.stringify(otherMission) }))
      .rejects.toThrowError("not bound to this signer's mission");
    await expect(payingFetch(new URL(scanUrl.replace("/scan", "/scan?x=1")), { ...init, body: JSON.stringify(scanRequest) }))
      .rejects.toThrowError("not the mission's scan URL");
    expect(authorizer.calls).toHaveLength(0);
  });
});

describe("RemoteRestrictedSigner", () => {
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: "hedera:testnet",
    asset: "0.0.0",
    amount: amountTinybar,
    payTo: providerAccountId,
    maxTimeoutSeconds: 180,
    extra: { feePayer: feePayerAccountId },
  };
  const scanUrl = "http://127.0.0.1:4401/scan";

  it("rejects an unacceptable challenge before calling the signer", async () => {
    const authorizer = new EmulatedSigner(scanUrl);
    const signer = signerFor(authorizer, scanUrl);

    await expect(signer.createPartiallySignedTransferTransaction({ ...requirements, network: "hedera:mainnet" } as never))
      .rejects.toBeInstanceOf(ChallengeRejectedError);
    expect(authorizer.calls).toHaveLength(0);
  });

  it("retains only an authorization bound to the mission and the exact transaction bytes", async () => {
    const authorizer = new EmulatedSigner(scanUrl);
    const signer = signerFor(authorizer, scanUrl, scanRequest, "7");
    const transaction = await signer.createPartiallySignedTransferTransaction(requirements);
    const retained = signer.authorizationFor(transaction);

    expect(retained).toMatchObject({
      missionId: scanRequest.missionId,
      targetSha256,
      nonce: "7",
      transactionSha256: createHash("sha256").update(Buffer.from(transaction, "base64")).digest("hex"),
      borrowerAccountId: consumerAccountId,
      providerAccountId,
      amountTinybar,
      scanUrl,
    });
    expect(signer.authorizationFor(`${transaction.slice(0, -4)}AAAA`)).toBeUndefined();

    for (const tamper of [
      (r: AuthorizeResponse) => ({ ...r, paymentAuthorization: { ...r.paymentAuthorization, missionId: otherMission.missionId } }),
      (r: AuthorizeResponse) => ({ ...r, paymentAuthorization: { ...r.paymentAuthorization, amountTinybar: "1" } }),
      (r: AuthorizeResponse) => ({ ...r, paymentAuthorization: { ...r.paymentAuthorization, transactionSha256: "0".repeat(64) } }),
      (r: AuthorizeResponse) => ({ ...r, paymentAuthorization: { ...r.paymentAuthorization, scanUrl: "http://127.0.0.1:4402/scan" } }),
      (r: AuthorizeResponse) => ({ ...r, paymentAuthorization: { ...r.paymentAuthorization, nonce: "8" } }),
    ]) {
      authorizer.tamper = tamper;
      await expect(signer.createPartiallySignedTransferTransaction(requirements))
        .rejects.toThrowError("not bound to this payment");
    }
  });
});

describe("HttpX402Client", () => {
  it("implements the orchestrator boundary end to end against the real provider", async () => {
    const { scanUrl, facilitator, store, authorizer } = await provider();
    const client = new HttpX402Client({ scanUrl, now: () => observedAt });
    const signer = signerFor(authorizer, scanUrl, scanRequest, "3");

    const challenge = await client.request(scanRequest);
    expect(challenge).toEqual({
      status: 402,
      requirements: {
        scheme: "exact",
        network: "hedera:testnet",
        asset: "0.0.0",
        amount: amountTinybar,
        payTo: providerAccountId,
        maxTimeoutSeconds: 180,
        extra: { feePayer: feePayerAccountId },
      },
    });
    const transaction = await signer.createPartiallySignedTransferTransaction(challenge.requirements);
    const authorization = signer.authorizationFor(transaction)!;
    const paid = await client.retryWithPayment(
      { ...scanRequest, paymentAuthorization: { ...authorization, amountTinybar: BigInt(authorization.amountTinybar) } },
      transaction,
    );

    expect(paid.status).toBe(200);
    expect(paid.report).toMatchObject({ missionId: scanRequest.missionId, targetSha256, providerId: "provider-a" });
    expect(paid.receipt).toEqual({
      missionId: scanRequest.missionId,
      transactionId: authorization.transactionId,
      network: "hedera:testnet",
      payer: consumerAccountId,
      recipientAccountId: providerAccountId,
      asset: "0.0.0",
      amountTinybar: 1_000_000n,
      settledAt: observedAt,
    });
    expect(store.getPayment(authorization.transactionId)?.status).toBe("completed");
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("refuses a paid retry without its mission's challenge or with foreign transaction bytes", async () => {
    const { scanUrl, facilitator, authorizer } = await provider();
    const client = new HttpX402Client({ scanUrl, now: () => observedAt });
    const signer = signerFor(authorizer, scanUrl);
    const challenge = await client.request(scanRequest);
    const transaction = await signer.createPartiallySignedTransferTransaction(challenge.requirements);
    const authorization = signer.authorizationFor(transaction)!;
    const paidRequest = { ...scanRequest, paymentAuthorization: { ...authorization, amountTinybar: BigInt(authorization.amountTinybar) } };

    await expect(client.retryWithPayment({ ...paidRequest, ...otherMission, paymentAuthorization: { ...paidRequest.paymentAuthorization, missionId: otherMission.missionId } }, transaction))
      .rejects.toThrowError("no challenge retained");
    const foreign = await signerFor(authorizer, scanUrl, scanRequest, "2").createPartiallySignedTransferTransaction(challenge.requirements);
    await expect(client.retryWithPayment(paidRequest, foreign))
      .rejects.toThrowError("not bound to this mission's challenge and transaction");
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it("surfaces the provider's frozen error code when the paid retry is refused", async () => {
    const { scanUrl, facilitator, authorizer } = await provider();
    const client = new HttpX402Client({ scanUrl, now: () => observedAt });
    const signer = signerFor(authorizer, scanUrl);
    const challenge = await client.request(scanRequest);
    const transaction = await signer.createPartiallySignedTransferTransaction(challenge.requirements);
    const authorization = signer.authorizationFor(transaction)!;

    const attempt = client.retryWithPayment(
      { ...scanRequest, paymentAuthorization: { ...authorization, amountTinybar: BigInt(authorization.amountTinybar), signature: "1".repeat(128) } },
      transaction,
    );
    await expect(attempt).rejects.toBeInstanceOf(X402RequestError);
    await expect(attempt).rejects.toMatchObject({ status: 401, code: "payment_authorization_invalid" });
    expect(facilitator.verify).not.toHaveBeenCalled();
  });
});

describe("createHttpPaymentAuthorizer", () => {
  const request: AuthorizeRequest = {
    missionId: scanRequest.missionId,
    requirements: {
      scheme: "exact",
      network: "hedera:testnet",
      asset: "0.0.0",
      amount: amountTinybar,
      payTo: providerAccountId,
      maxTimeoutSeconds: 180,
      extra: { feePayer: feePayerAccountId },
    },
    nonce: "1",
  };

  it("posts the frozen request with the consumer credential and maps refusals to error codes", async () => {
    const seen: { authorization: string | undefined; body: unknown; path: string | undefined }[] = [];
    const baseUrl = await listen(createServer((incoming, outgoing) => {
      let raw = "";
      incoming.on("data", chunk => { raw += chunk; });
      incoming.on("end", () => {
        seen.push({ authorization: incoming.headers.authorization, body: JSON.parse(raw), path: incoming.url });
        outgoing.setHeader("content-type", "application/json");
        if (seen.length === 1) {
          outgoing.statusCode = 403;
          outgoing.end(JSON.stringify({ code: "cap_exceeded", detail: "Amount exceeds the mission cap" }));
        } else {
          outgoing.statusCode = 500;
          outgoing.end("boom");
        }
      });
    }).listen(0, "127.0.0.1"));
    const authorizer = createHttpPaymentAuthorizer({ baseUrl, credential: "c".repeat(43) });

    await expect(authorizer.authorize(request)).rejects.toMatchObject({ status: 403, code: "cap_exceeded" });
    await expect(authorizer.authorize(request)).rejects.toMatchObject({ status: 500, code: "internal_error" });
    expect(seen[0]).toEqual({ authorization: `Bearer ${"c".repeat(43)}`, body: request, path: "/authorize" });
  });

  it("only talks to HTTPS or loopback origins", () => {
    expect(() => createHttpPaymentAuthorizer({ baseUrl: "http://signer.internal:3004", credential: "c" })).toThrowError(/origin/);
    expect(() => createHttpPaymentAuthorizer({ baseUrl: "http://127.0.0.1:3004/authorize", credential: "c" })).toThrowError(/origin/);
    expect(() => createHttpPaymentAuthorizer({ baseUrl: "https://signer.example", credential: "c" })).not.toThrow();
  });
});
