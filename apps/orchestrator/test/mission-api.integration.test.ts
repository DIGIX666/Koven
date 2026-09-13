import type { Server } from "node:http";

import type { Application } from "express";
import { ConsumerPolicyRejectedError, type ConsumerMissionObserver } from "@koven/consumer-agent";
import { loanIdForOffer } from "@koven/credit-protocol";
import { ErrorCode } from "@koven/domain";
import {
  getIdempotencyResult,
  getLoan,
  getMission,
  getMissionCompletion,
  getMissionPolicy,
  listMissionEvents,
  openDatabase,
  type KovenDatabase,
} from "@koven/persistence";
import { CallbackResponseSchema, MAX_HTTP_BODY_BYTES, MissionDetailResponseSchema, MissionSchema } from "@koven/schemas";
import { NoopAuditSink } from "@koven/testing";
import { loadPoseidon } from "@koven/x402";
import { buildMerkleTree } from "@koven/zk-policy";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  callbackSignature,
  CompletionError,
  CompletionHandler,
  createOrchestratorApp,
  MissionStateMachine,
  MissionWorkflow,
  RepaymentRequestError,
  RepaymentWorkflow,
} from "../src/index.js";
import { hashBytes, hashCanonicalJson } from "../src/canonical.js";

const timestamp = "2026-09-11T12:00:00.000Z";
const epochSeconds = String(Math.floor(Date.parse(timestamp) / 1_000));
const settlementTxId = "0.0.10@1789128000.000000001";
const repaymentTxId = "0.0.10@1789128000.000000002";
const fundingTxId = "0.0.30@1789128000.000000003";
const offerId = "offer-1";
const loanId = loanIdForOffer(offerId);
const source = "pragma solidity ^0.8.0; contract Example {}";
const targetSha256 = hashBytes(source);
const callbackSecret = Buffer.alloc(32, 9);
const proofBundle = {
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

const databases: KovenDatabase[] = [];
const servers: Server[] = [];

interface RuntimeOptions {
  readonly borrowerBalance?: bigint;
  readonly budgetTinybar?: bigint;
  readonly providerPriceTinybar?: bigint;
  readonly noProviders?: boolean;
  readonly repaymentFailures?: number;
  readonly settlementFailures?: number;
  readonly settlementMismatch?: boolean;
  readonly paymentFailureAfterFunding?: boolean;
  readonly continueAfterFunding?: Promise<void>;
  /** The keyless consumer refuses on a frozen policy code at the given step. */
  readonly policyRejection?: { readonly code: string; readonly at: "proof" | "acceptance" | "authorize" };
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
  const unsignedReport = {
    schemaVersion: 1 as const,
    missionId: "mission-1",
    targetSha256,
    providerId: provider.id,
    findings: [],
    startedAt: timestamp,
    completedAt: timestamp,
  };
  const report = { ...unsignedReport, reportSha256: hashCanonicalJson(unsignedReport) };
  const receipt = {
    missionId: "mission-1",
    transactionId: settlementTxId,
    network: "hedera:testnet" as const,
    payer: "0.0.10",
    recipientAccountId: provider.accountId,
    asset: "0.0.0" as const,
    amountTinybar: providerPriceTinybar,
    settledAt: timestamp,
  };
  const consumer = {
    execute: vi.fn(async (_input: unknown, observer?: ConsumerMissionObserver) => {
      const scan = { status: 200 as const, receipt, report };
      const refuse = (at: "proof" | "acceptance" | "authorize") => {
        if (options.policyRejection?.at === at) {
          throw new ConsumerPolicyRejectedError(options.policyRejection.code, `refused at ${at}`);
        }
      };
      const pay = async () => {
        await observer?.onProgress({ type: "payment-preparation" });
        refuse("authorize");
        await observer?.onProgress({
          type: "payment-authorized",
          transactionId: settlementTxId,
          nonce: "1",
          amountTinybar: providerPriceTinybar,
        });
        await observer?.onProgress({ type: "service-paid", scan });
        return scan;
      };
      refuse("proof");
      await observer?.onProgress({
        type: "proof-generated",
        nonce: "1",
        publicSignals: proofBundle.publicSignals,
        vkeyHash: proofBundle.vkeyHash,
      });
      const balance = options.borrowerBalance ?? 1n;
      if (balance >= providerPriceTinybar) return { scan: await pay() };
      const principalTinybar = providerPriceTinybar - balance;
      const request = {
        id: "credit-1",
        missionId: "mission-1",
        borrowerAccountId: "0.0.10",
        principalTinybar,
        requestedTermSeconds: 3_600,
        purposeHash: "c".repeat(64),
        createdAt: timestamp,
        signature: "d".repeat(128),
      };
      await observer?.onProgress({ type: "credit-requested", request });
      refuse("acceptance");
      const offer = {
        id: offerId,
        requestId: request.id,
        lenderAccountId: "0.0.30",
        principalTinybar,
        feeTinybar: 1n,
        termSeconds: 3_600,
        expiresAt: "2026-09-11T13:00:00.000Z",
        termsHash: "e".repeat(64),
        signature: "f".repeat(128),
      };
      const acceptance = {
        acceptance: {
          requestId: request.id,
          missionId: request.missionId,
          borrowerAccountId: request.borrowerAccountId,
          lenderAccountId: offer.lenderAccountId,
          offerId: offer.id,
          termsHash: offer.termsHash,
          expiresAt: offer.expiresAt,
        },
        signature: "a".repeat(128),
      };
      await observer?.onProgress({ type: "funded", request, offer, acceptance, fundingTxId });
      await options.continueAfterFunding;
      if (options.paymentFailureAfterFunding) throw new Error("Provider payment failed");
      return {
        scan: await pay(),
        credit: {
          request,
          offer,
          acceptance,
          fundingTxId,
        },
      };
    }),
  };
  const policyRegistrars = [
    { register: vi.fn(async () => undefined) },
    { register: vi.fn(async () => undefined) },
  ];
  const workflow = new MissionWorkflow({
    database,
    stateMachine,
    consumer,
    policyRegistrars,
    providers: options.noProviders ? [] : [provider],
    borrowerAccountId: "0.0.10",
    now: () => timestamp,
    missionId: () => "mission-1",
  });

  let remainingSettlementFailures = options.settlementFailures ?? 0;
  const settlementConfirmer = {
    confirm: vi.fn(async () => {
      if (options.settlementMismatch) {
        throw Object.assign(new Error("Settlement recipient differs"), {
          code: ErrorCode.FUNDING_MISMATCH,
        });
      }
      if (remainingSettlementFailures > 0) {
        remainingSettlementFailures -= 1;
        throw new CompletionError(ErrorCode.SETTLEMENT_UNCONFIRMED, 503, "Settlement is not visible yet");
      }
      return { settledAt: timestamp };
    }),
  };
  const signerCompletion = {
    complete: vi.fn(async () => ({ status: "accepted" as const })),
  };
  const completionHandler = new CompletionHandler({
    database,
    stateMachine,
    providerCallbackSecrets: { [provider.id]: callbackSecret },
    settlementConfirmer,
    signerCompletion,
    now: () => new Date(timestamp),
  });
  let remainingRepaymentFailures = options.repaymentFailures ?? 0;
  const repaymentClient = {
    repay: vi.fn(async () => {
      if (remainingRepaymentFailures > 0) {
        remainingRepaymentFailures -= 1;
        throw new RepaymentRequestError(503, ErrorCode.SETTLEMENT_UNCONFIRMED, "Repayment is uncertain");
      }
      return { transactionId: repaymentTxId };
    }),
  };
  const repaymentWorkflow = new RepaymentWorkflow({ database, stateMachine, client: repaymentClient });
  const app = createOrchestratorApp({ database, workflow, completionHandler, repaymentWorkflow });
  return {
    app,
    database,
    sink,
    consumer,
    policyRegistrars,
    report,
    provider,
    settlementConfirmer,
    signerCompletion,
    repaymentClient,
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
  maxBudgetTinybar: budgetTinybar.toString(10),
  targetRef: "Example.sol",
  source,
});

const callbackBody = (report: ReturnType<typeof runtime>["report"], transactionId = settlementTxId) => ({
  outcome: {
    missionId: "mission-1",
    delivered: true,
    reportSha256: report.reportSha256,
    settlementTxId: transactionId,
    observedAt: timestamp,
  },
  report,
});

async function postMission(baseUrl: string, budgetTinybar = 1_000n): Promise<Response> {
  return fetch(`${baseUrl}/missions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(createRequest(budgetTinybar)),
  });
}

async function postCallback(
  baseUrl: string,
  body: unknown,
  options: { timestamp?: string; signature?: string; key?: string } = {},
): Promise<Response> {
  const raw = Buffer.from(JSON.stringify(body));
  const candidate = body as { outcome: { missionId: string }; report: { reportSha256: string } };
  const key = options.key ?? `mission-complete:${candidate.outcome.missionId}:${candidate.report.reportSha256}`;
  const callbackTimestamp = options.timestamp ?? epochSeconds;
  return fetch(`${baseUrl}/callbacks/mission-complete`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
      "x-callback-timestamp": callbackTimestamp,
      "x-callback-signature": options.signature
        ?? callbackSignature(callbackSecret, callbackTimestamp, key, raw),
    },
    body: raw,
  });
}

async function waitForState(database: KovenDatabase, state: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (getMission(database, "mission-1")?.state !== state && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  expect(getMission(database, "mission-1")?.state).toBe(state);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error));
  })));
  for (const database of databases.splice(0)) database.close();
});

describe("orchestrator mission and trusted completion API", () => {
  it("waits in running until a verified callback closes the mission through signer repayment", async () => {
    const test = runtime();
    const baseUrl = await listen(test.app);

    const created = MissionSchema.parse(await (await postMission(baseUrl, test.budgetTinybar)).json());
    expect(created.state).toBe("running");
    expect(test.consumer.execute).toHaveBeenCalledTimes(1);
    expect(test.policyRegistrars.every(registrar => registrar.register.mock.calls.length === 1)).toBe(true);
    expect(getLoan(test.database, loanId)?.state).toBe("funded");
    const singletonRoot = buildMerkleTree([test.provider.accountId], await loadPoseidon()).root;
    expect(created.approvedRecipientsRoot).toBe(singletonRoot);
    expect(getMissionPolicy(test.database, "mission-1")?.approvedRecipientsRoot).toBe(singletonRoot);
    expect(test.policyRegistrars[0]!.register).toHaveBeenCalledWith(expect.objectContaining({
      approvedRecipientsRoot: singletonRoot,
      spendingCapTinybar: test.budgetTinybar.toString(10),
    }));
    expect(listMissionEvents(test.database, "mission-1").find(event => event.type === "proof-generated"))
      .toMatchObject({ payload: { nonce: "1", publicSignals: proofBundle.publicSignals, vkeyHash: proofBundle.vkeyHash } });

    const callback = await postCallback(baseUrl, callbackBody(test.report));
    expect(callback.status, await callback.clone().text()).toBe(202);
    expect(await callback.json()).toEqual({ status: "accepted" });

    const detail = MissionDetailResponseSchema.parse(await (await fetch(`${baseUrl}/missions/mission-1`)).json());
    expect(detail.state).toBe("closed");
    expect(getLoan(test.database, loanId)).toMatchObject({
      state: "repaid",
      repaymentTxId,
    });
    expect(getMissionCompletion(test.database, "mission-1")).toMatchObject({
      settlementTxId,
      settlementPayerAccountId: "0.0.10",
      settlementRecipientAccountId: test.provider.accountId,
      settlementAsset: "0.0.0",
      settlementAmountTinybar: test.provider.priceTinybar,
      settlementConfirmedAt: timestamp,
      reportSha256: test.report.reportSha256,
    });
    expect(test.settlementConfirmer.confirm).toHaveBeenCalledWith({
      transactionId: settlementTxId,
      payerAccountId: "0.0.10",
      recipientAccountId: test.provider.accountId,
      amountTinybar: test.provider.priceTinybar,
    });
    expect(test.signerCompletion.complete).toHaveBeenCalledTimes(1);
    expect(test.repaymentClient.repay).toHaveBeenCalledWith({
      missionId: "mission-1",
      loanId,
      idempotencyKey: `repayment:${loanId}`,
    });
  });

  it("closes a sufficiently funded mission without creating or repaying a loan", async () => {
    const test = runtime({ borrowerBalance: 100n });
    const baseUrl = await listen(test.app);

    expect(MissionSchema.parse(await (await postMission(baseUrl)).json()).state).toBe("running");
    expect(getLoan(test.database, loanId)).toBeUndefined();
    expect((await postCallback(baseUrl, callbackBody(test.report))).status).toBe(202);
    expect(MissionDetailResponseSchema.parse(await (
      await fetch(`${baseUrl}/missions/mission-1`)
    ).json()).state).toBe("closed");
    expect(test.repaymentClient.repay).not.toHaveBeenCalled();
  });

  it("authenticates identical replays and never requests a second repayment", async () => {
    const test = runtime();
    const baseUrl = await listen(test.app);
    await postMission(baseUrl);
    const body = callbackBody(test.report);
    expect((await postCallback(baseUrl, body)).status).toBe(202);

    const duplicate = await postCallback(baseUrl, body, {
      timestamp: String(Number(epochSeconds) + 1),
    });
    expect(duplicate.status).toBe(202);
    expect(CallbackResponseSchema.parse(await duplicate.json())).toEqual({
      status: "duplicate",
      code: ErrorCode.CALLBACK_DUPLICATE,
    });
    expect(test.repaymentClient.repay).toHaveBeenCalledTimes(1);
    expect(test.settlementConfirmer.confirm).toHaveBeenCalledTimes(1);
    expect(listMissionEvents(test.database, "mission-1").map(event => event.type))
      .toContain("callback-duplicate");
  });

  it("serializes concurrent duplicate callbacks into one repayment command", async () => {
    const test = runtime();
    const baseUrl = await listen(test.app);
    await postMission(baseUrl);
    const body = callbackBody(test.report);

    const responses = await Promise.all([
      postCallback(baseUrl, body),
      postCallback(baseUrl, body),
    ]);
    expect(responses.map(response => response.status)).toEqual([202, 202]);
    expect(test.repaymentClient.repay).toHaveBeenCalledTimes(1);
    expect(getLoan(test.database, loanId)?.state).toBe("repaid");
  });

  it("rejects invalid authentication and report contracts before ledger confirmation", async () => {
    const test = runtime();
    const baseUrl = await listen(test.app);
    await postMission(baseUrl);
    const body = callbackBody(test.report);

    const invalidHmac = await postCallback(baseUrl, body, { signature: "0".repeat(64) });
    expect(invalidHmac.status).toBe(401);
    expect(await invalidHmac.json()).toMatchObject({ code: ErrorCode.CALLBACK_AUTH_INVALID });

    const stale = await postCallback(baseUrl, body, { timestamp: "1" });
    expect(stale.status).toBe(401);
    expect(await stale.json()).toMatchObject({ code: ErrorCode.CALLBACK_AUTH_INVALID });

    const malformed = { outcome: body.outcome, report: { reportSha256: test.report.reportSha256 } };
    const invalidReport = await postCallback(baseUrl, malformed);
    expect(invalidReport.status).toBe(400);
    expect(await invalidReport.json()).toMatchObject({ code: ErrorCode.REPORT_SCHEMA_INVALID });

    const unsignedMismatch = { ...test.report, providerId: "provider-b", reportSha256: undefined };
    const { reportSha256: _ignored, ...unsigned } = unsignedMismatch;
    const mismatchReport = { ...unsigned, reportSha256: hashCanonicalJson(unsigned) };
    const mismatch = await postCallback(baseUrl, callbackBody(mismatchReport));
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ code: ErrorCode.REPORT_BINDING_MISMATCH });
    expect(test.settlementConfirmer.confirm).not.toHaveBeenCalled();
    expect(test.repaymentClient.repay).not.toHaveBeenCalled();
  });

  it("does not consume idempotency while settlement is unavailable", async () => {
    const test = runtime({ settlementFailures: 1 });
    const baseUrl = await listen(test.app);
    await postMission(baseUrl);
    const body = callbackBody(test.report);
    const key = `mission-complete:mission-1:${test.report.reportSha256}`;

    const pending = await postCallback(baseUrl, body);
    expect(pending.status).toBe(503);
    expect(await pending.json()).toMatchObject({ code: ErrorCode.SETTLEMENT_UNCONFIRMED });
    expect(getIdempotencyResult(test.database, key)).toBeUndefined();

    const accepted = await postCallback(baseUrl, body);
    expect(accepted.status).toBe(202);
    expect(getIdempotencyResult(test.database, key)?.statusCode).toBe(202);
    expect(test.repaymentClient.repay).toHaveBeenCalledTimes(1);
  });

  it("returns a retryable response when a provider callback races mission persistence", async () => {
    let resume!: () => void;
    const continueAfterFunding = new Promise<void>(resolve => { resume = resolve; });
    const test = runtime({ continueAfterFunding });
    const baseUrl = await listen(test.app);
    const missionResponse = postMission(baseUrl);
    await waitForState(test.database, "funded");

    const early = await postCallback(baseUrl, callbackBody(test.report));
    expect(early.status).toBe(503);
    expect(await early.json()).toMatchObject({ code: ErrorCode.SETTLEMENT_UNCONFIRMED });
    expect(getIdempotencyResult(test.database, `mission-complete:mission-1:${test.report.reportSha256}`))
      .toBeUndefined();

    resume();
    expect(MissionSchema.parse(await (await missionResponse).json()).state).toBe("running");
    expect((await postCallback(baseUrl, callbackBody(test.report))).status).toBe(202);
    expect(getLoan(test.database, loanId)?.state).toBe("repaid");
  });

  it("rejects independently observed settlement mismatches as callback binding failures", async () => {
    const test = runtime({ settlementMismatch: true });
    const baseUrl = await listen(test.app);
    await postMission(baseUrl);
    const body = callbackBody(test.report);
    const key = `mission-complete:mission-1:${test.report.reportSha256}`;

    const response = await postCallback(baseUrl, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: ErrorCode.REPORT_BINDING_MISMATCH });
    expect(getIdempotencyResult(test.database, key)).toBeUndefined();
    expect(test.signerCompletion.complete).not.toHaveBeenCalled();
    expect(test.repaymentClient.repay).not.toHaveBeenCalled();
  });

  it("resumes repayment from a persisted completion after a lost signer response", async () => {
    const test = runtime({ repaymentFailures: 1 });
    const baseUrl = await listen(test.app);
    await postMission(baseUrl);
    const body = callbackBody(test.report);

    const uncertain = await postCallback(baseUrl, body);
    expect(uncertain.status).toBe(503);
    expect(await uncertain.json()).toMatchObject({ code: ErrorCode.SETTLEMENT_UNCONFIRMED });
    expect(MissionDetailResponseSchema.parse(await (await fetch(`${baseUrl}/missions/mission-1`)).json()).state)
      .toBe("repayment-pending");

    const recovered = await postCallback(baseUrl, body, { timestamp: String(Number(epochSeconds) + 1) });
    expect(recovered.status).toBe(202);
    expect(await recovered.json()).toMatchObject({ status: "duplicate" });
    expect(test.repaymentClient.repay).toHaveBeenCalledTimes(2);
    expect(getLoan(test.database, loanId)?.repaymentTxId).toBe(repaymentTxId);
  });

  it("returns a conflict for authenticated reuse of a stored callback key with different content", async () => {
    const test = runtime();
    const baseUrl = await listen(test.app);
    await postMission(baseUrl);
    const body = callbackBody(test.report);
    const key = `mission-complete:mission-1:${test.report.reportSha256}`;
    expect((await postCallback(baseUrl, body)).status).toBe(202);

    const conflicting = callbackBody({ ...test.report, providerId: "provider-b" });
    const response = await postCallback(baseUrl, conflicting, { key });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: ErrorCode.IDEMPOTENCY_CONFLICT });
    expect(test.repaymentClient.repay).toHaveBeenCalledTimes(1);
  });

  it("preserves request errors and closes policy rejections without payment", async () => {
    const test = runtime({ budgetTinybar: 50n, providerPriceTinybar: 100n });
    const baseUrl = await listen(test.app);
    const tooLarge = await fetch(`${baseUrl}/missions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...createRequest(), source: "a".repeat(MAX_HTTP_BODY_BYTES) }),
    });
    expect(tooLarge.status).toBe(413);

    const rejected = MissionSchema.parse(await (await postMission(baseUrl, test.budgetTinybar)).json());
    expect(rejected.state).toBe("closed");
    expect(listMissionEvents(test.database, "mission-1").map(event => event.type)).toContain("payment-rejected");
    expect(getMissionPolicy(test.database, "mission-1")).toBeUndefined();
    expect(test.consumer.execute).not.toHaveBeenCalled();
    expect(test.policyRegistrars.every(registrar => registrar.register.mock.calls.length === 0)).toBe(true);
  });

  it("routes an over-cap signer refusal through policy-rejected to recovery with the code recorded", async () => {
    const test = runtime({ policyRejection: { code: ErrorCode.CAP_EXCEEDED, at: "authorize" } });
    const baseUrl = await listen(test.app);

    const response = await postMission(baseUrl);
    expect(response.status).toBe(201);
    expect(MissionSchema.parse(await response.json()).state).toBe("defaulted");
    expect(getLoan(test.database, loanId)?.state).toBe("funded");
    const transitions = listMissionEvents<{ from: string; to: string; detail: unknown }>(test.database, "mission-1")
      .filter(event => event.type === "payment-rejected" || event.type === "mission-failed")
      .map(event => [event.payload.from, event.payload.to, event.payload.detail]);
    const detail = { reason: "refused at authorize", code: ErrorCode.CAP_EXCEEDED };
    expect(transitions).toEqual([
      ["payment-preparation", "policy-rejected", detail],
      ["policy-rejected", "recovery", detail],
      ["recovery", "defaulted", detail],
    ]);
    expect(test.repaymentClient.repay).not.toHaveBeenCalled();
  });

  it("closes a mission whose proof is refused before any credit as a policy rejection", async () => {
    const test = runtime({ policyRejection: { code: ErrorCode.RECIPIENT_NOT_APPROVED, at: "proof" } });
    const baseUrl = await listen(test.app);

    expect(MissionSchema.parse(await (await postMission(baseUrl)).json()).state).toBe("closed");
    expect(getLoan(test.database, loanId)).toBeUndefined();
    const events = listMissionEvents<{ from: string; to: string; detail: unknown }>(test.database, "mission-1");
    expect(events.map(event => event.type)).toEqual([
      "mission-created",
      "providers-ranked",
      "payment-rejected",
      "mission-failed",
      "mission-failed",
    ]);
    expect(events[2]!.payload).toMatchObject({
      from: "payment-preparation",
      to: "policy-rejected",
      detail: { code: ErrorCode.RECIPIENT_NOT_APPROVED },
    });
    expect(events.at(-1)!.payload).toMatchObject({ from: "recovery", to: "closed" });
  });

  it("records the code of a policy refusal during credit acceptance on the failure path", async () => {
    const test = runtime({ policyRejection: { code: ErrorCode.PROOF_VKEY_MISMATCH, at: "acceptance" } });
    const baseUrl = await listen(test.app);

    expect(MissionSchema.parse(await (await postMission(baseUrl)).json()).state).toBe("closed");
    const failures = listMissionEvents<{ from: string; to: string; detail: unknown }>(test.database, "mission-1")
      .filter(event => event.type === "mission-failed")
      .map(event => [event.payload.from, event.payload.to]);
    expect(failures).toEqual([["credit-requested", "failed"], ["failed", "recovery"], ["recovery", "closed"]]);
    expect(listMissionEvents(test.database, "mission-1").filter(event => event.type === "mission-failed")
      .every(event => (event.payload as { detail: { code?: string } }).detail.code === ErrorCode.PROOF_VKEY_MISMATCH)).toBe(true);
  });

  it("persists funded credit before payment and defaults visibly when payment fails", async () => {
    const test = runtime({ paymentFailureAfterFunding: true });
    const baseUrl = await listen(test.app);

    const response = await postMission(baseUrl);
    expect(response.status).toBe(201);
    expect(MissionSchema.parse(await response.json()).state).toBe("defaulted");
    expect(getLoan(test.database, loanId)).toMatchObject({
      state: "funded",
      fundingTxId,
    });
    expect(listMissionEvents(test.database, "mission-1").map(event => event.type)).toEqual(expect.arrayContaining([
      "credit-requested",
      "offer-accepted",
      "mission-failed",
    ]));
    expect(test.repaymentClient.repay).not.toHaveBeenCalled();
  });
});
