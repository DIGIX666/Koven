import type { Server } from "node:http";

import type { Application } from "express";
import { getLoan, listMissionEvents, openDatabase, type KovenDatabase } from "@koven/persistence";
import { CallbackResponseSchema, MissionDetailResponseSchema, MissionSchema } from "@koven/schemas";
import {
  FakeHederaAdapter,
  FakeSigner,
  FakeX402Client,
  NoopAuditSink,
} from "@koven/testing";
import { afterEach, describe, expect, it } from "vitest";

import {
  CompletionHandler,
  createOrchestratorApp,
  MissionStateMachine,
  MissionWorkflow,
} from "../src/index.js";
import { hashBytes, hashCanonicalJson } from "../src/canonical.js";

const timestamp = "2026-09-11T12:00:00.000Z";
const epochSeconds = String(Math.floor(Date.parse(timestamp) / 1_000));
const transactionId = "0.0.10@1789128000.000000001";
const source = "pragma solidity ^0.8.0; contract Example {}";
const targetSha256 = hashBytes(source);
const reportSha256 = "a".repeat(64);

const databases: KovenDatabase[] = [];
const servers: Server[] = [];

interface RuntimeOptions {
  borrowerBalance?: bigint;
  budgetTinybar?: bigint;
  providerPriceTinybar?: bigint;
  failSigner?: boolean;
  noProviders?: boolean;
}

const runtime = (options: RuntimeOptions = {}) => {
  const database = openDatabase(":memory:");
  databases.push(database);
  const sink = new NoopAuditSink();
  let eventSequence = 0;
  const stateMachine = new MissionStateMachine(database, sink, {
    now: () => timestamp,
    eventId: () => `event-${++eventSequence}`,
  });
  const completionHandler = new CompletionHandler(database, stateMachine, () => timestamp);
  const hedera = new FakeHederaAdapter({
    balances: {
      "0.0.10": options.borrowerBalance ?? 1n,
      "0.0.30": 10_000n,
    },
  });
  const signer = new FakeSigner("0.0.10");
  if (options.failSigner) signer.failNext(new Error("injected signer failure"));
  const providerPriceTinybar = options.providerPriceTinybar ?? 100n;
  const provider = {
    id: "provider-a",
    accountId: "0.0.20",
    endpoint: "http://provider.invalid",
    capability: "solidity-scan",
    priceTinybar: providerPriceTinybar,
    reputationScore: 0.9,
    expectedLatencyMs: 50,
  };
  const requirements = {
    scheme: "exact" as const,
    network: "hedera:testnet" as const,
    asset: "0.0.0" as const,
    amount: providerPriceTinybar.toString(),
    payTo: provider.accountId,
    maxTimeoutSeconds: 180,
    extra: { feePayer: "0.0.40" },
  };
  const report = {
    schemaVersion: 1 as const,
    missionId: "mission-1",
    targetSha256,
    providerId: provider.id,
    findings: [],
    startedAt: timestamp,
    completedAt: timestamp,
    reportSha256,
  };
  const receipt = {
    missionId: "mission-1",
    transactionId,
    network: "hedera:testnet" as const,
    payer: "0.0.10",
    recipientAccountId: provider.accountId,
    asset: "0.0.0" as const,
    amountTinybar: providerPriceTinybar,
    settledAt: timestamp,
  };
  const x402Client = new FakeX402Client({
    challenge: { status: 402, requirements },
    settlement: { status: 200, receipt, report },
  });
  const workflow = new MissionWorkflow({
    database,
    stateMachine,
    completionHandler,
    hedera,
    signer,
    x402Client,
    providers: options.noProviders ? [] : [provider],
    borrowerAccountId: "0.0.10",
    lenderAccountId: "0.0.30",
    approvedRecipientsRoot: "1",
    now: () => timestamp,
    missionId: () => "mission-1",
  });
  const app = createOrchestratorApp({ database, workflow, completionHandler });
  return {
    app,
    database,
    sink,
    hedera,
    signer,
    x402Client,
    report,
    receipt,
    budgetTinybar: options.budgetTinybar ?? 1_000n,
  };
};

const listen = async (app: Application): Promise<string> => {
  const server = await new Promise<Server>((resolve, reject) => {
    const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
    candidate.once("error", reject);
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test server address");
  return `http://127.0.0.1:${address.port}`;
};

const createRequest = (budgetTinybar = 1_000n) => ({
  prompt: "Scan Example.sol",
  maxBudgetTinybar: budgetTinybar.toString(),
  targetRef: "Example.sol",
  source,
});

const callbackBody = (report: ReturnType<typeof runtime>["report"], settlementTxId = transactionId) => ({
  outcome: {
    missionId: "mission-1",
    delivered: true,
    reportSha256: report.reportSha256,
    settlementTxId,
    observedAt: timestamp,
  },
  report,
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error));
  })));
  for (const database of databases.splice(0)) database.close();
});

describe("orchestrator mission API on fakes", () => {
  it("drives POST /missions to closed and returns persisted state through GET", async () => {
    const test = runtime();
    const baseUrl = await listen(test.app);

    const createdResponse = await fetch(`${baseUrl}/missions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createRequest(test.budgetTinybar)),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect(MissionSchema.parse(created).state).toBe("closed");

    const detailResponse = await fetch(`${baseUrl}/missions/mission-1`);
    expect(detailResponse.status).toBe(200);
    const detail = MissionDetailResponseSchema.parse(await detailResponse.json());
    expect(detail.state).toBe("closed");
    expect(detail.spentTinybar).toBe("100");
    expect(detail.events.length).toBeGreaterThan(8);

    expect(test.signer.requirements).toHaveLength(1);
    expect(test.x402Client.requests).toHaveLength(1);
    expect(test.x402Client.paidRetries).toHaveLength(1);
    expect(test.hedera.transfers).toHaveLength(2);
    expect(getLoan(test.database, "loan-mission-1")?.state).toBe("repaid");
    expect(test.sink.events).toHaveLength(detail.events.length);
  });

  it("returns duplicate for the same completion callback without repaying twice", async () => {
    const test = runtime();
    const baseUrl = await listen(test.app);
    await fetch(`${baseUrl}/missions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createRequest()),
    });
    const callback = callbackBody(test.report);

    const duplicateResponse = await fetch(`${baseUrl}/callbacks/mission-complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `mission-complete:mission-1:${reportSha256}`,
        "x-callback-timestamp": epochSeconds,
        "x-callback-signature": hashCanonicalJson(callback),
      },
      body: JSON.stringify(callback),
    });

    expect(duplicateResponse.status).toBe(200);
    expect(CallbackResponseSchema.parse(await duplicateResponse.json())).toEqual({
      status: "duplicate",
      code: "callback_duplicate",
    });
    expect(test.hedera.transfers).toHaveLength(2);
    expect(getLoan(test.database, "loan-mission-1")?.state).toBe("repaid");
  });

  it("rejects invalid API input and conflicting callback reuse with frozen errors", async () => {
    const test = runtime();
    const baseUrl = await listen(test.app);
    const invalidResponse = await fetch(`${baseUrl}/missions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "missing fields" }),
    });
    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toMatchObject({ code: "request_invalid" });

    const malformedResponse = await fetch(`${baseUrl}/missions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{invalid",
    });
    expect(malformedResponse.status).toBe(400);
    expect(await malformedResponse.json()).toMatchObject({ code: "request_invalid" });

    const missingResponse = await fetch(`${baseUrl}/missions/does-not-exist`);
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toMatchObject({ code: "not_found" });

    await fetch(`${baseUrl}/missions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createRequest()),
    });
    const conflicting = callbackBody({ ...test.report, providerId: "provider-b" });
    const conflictResponse = await fetch(`${baseUrl}/callbacks/mission-complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `mission-complete:mission-1:${reportSha256}`,
        "x-callback-timestamp": epochSeconds,
        "x-callback-signature": hashCanonicalJson(conflicting),
      },
      body: JSON.stringify(conflicting),
    });
    expect(conflictResponse.status).toBe(409);
    expect(await conflictResponse.json()).toMatchObject({ code: "idempotency_conflict" });
  });

  it("moves an injected signer failure through failed and recovery", async () => {
    const test = runtime({ failSigner: true });
    const baseUrl = await listen(test.app);
    const result = await fetch(`${baseUrl}/missions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createRequest()),
    });
    const mission = MissionSchema.parse(await result.json());

    expect(mission.state).toBe("closed");
    const events = listMissionEvents(test.database, "mission-1");
    expect(events.some(event => event.type === "mission-failed")).toBe(true);
    expect(test.x402Client.paidRetries).toHaveLength(0);
    expect(getLoan(test.database, "loan-mission-1")?.state).toBe("repaid");
  });

  it("moves an unrecoverable repayment to defaulted", async () => {
    const test = runtime({ borrowerBalance: 0n });
    const baseUrl = await listen(test.app);
    const response = await fetch(`${baseUrl}/missions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createRequest()),
    });
    const mission = MissionSchema.parse(await response.json());

    expect(mission.state).toBe("defaulted");
    expect(getLoan(test.database, "loan-mission-1")?.state).toBe("funded");
    expect(listMissionEvents(test.database, "mission-1").at(-1)?.type).toBe("mission-failed");
  });

  it("closes a policy-rejected mission without contacting payment services", async () => {
    const test = runtime({ budgetTinybar: 50n, providerPriceTinybar: 100n });
    const baseUrl = await listen(test.app);
    const response = await fetch(`${baseUrl}/missions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createRequest(test.budgetTinybar)),
    });
    const mission = MissionSchema.parse(await response.json());

    expect(mission.state).toBe("closed");
    expect(listMissionEvents(test.database, "mission-1").map(event => event.type))
      .toContain("payment-rejected");
    expect(test.signer.requirements).toHaveLength(0);
    expect(test.x402Client.requests).toHaveLength(0);
  });

  it("closes cleanly when provider discovery returns no candidates", async () => {
    const test = runtime({ noProviders: true });
    const baseUrl = await listen(test.app);
    const response = await fetch(`${baseUrl}/missions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createRequest()),
    });
    const mission = MissionSchema.parse(await response.json());

    expect(mission.state).toBe("closed");
    expect(listMissionEvents(test.database, "mission-1").map(event => event.type))
      .toContain("payment-rejected");
    expect(test.hedera.transfers).toHaveLength(0);
    expect(test.signer.requirements).toHaveLength(0);
    expect(test.x402Client.requests).toHaveLength(0);
  });
});
