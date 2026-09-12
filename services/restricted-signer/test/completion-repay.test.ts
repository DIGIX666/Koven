import { CREDIT_SIGNATURE_DOMAINS } from "@koven/domain";
import { listMissionEvents } from "@koven/persistence";
import { callbackSignature as providerCallbackSignature } from "@koven/resource-server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { canonicalJson, sha256Hex, signDomain } from "../src/canonical.js";
import { callbackSignature, CompletionService } from "../src/completion.js";
import { CreditService, purposeHashFor, termsHashFor } from "../src/credit.js";
import { SignerError } from "../src/errors.js";
import { PaymentGate } from "../src/gate.js";
import type { TransferConfirmer } from "../src/ledger.js";
import { type PreparedRepayment, type RepaymentLedger, REPAYMENT_FAILURE_GRACE_MS, RepaymentService } from "../src/repay.js";
import type { SignerStore } from "../src/store.js";
import {
  consumerAccountId,
  consumerKey,
  lenderAccountId,
  lenderKey,
  memoryStore,
  poseidonHasher,
  policy,
  providerAccountId,
  providerCallbackSecret,
  requirements,
  targetSha256,
} from "./helpers.js";

const settledAt = "2026-09-12T12:00:00.000Z";
const stores: SignerStore[] = [];
afterEach(() => stores.splice(0).forEach(store => store.close()));

const report = (overrides: Record<string, unknown> = {}) => {
  const unsigned = {
    schemaVersion: 1,
    missionId: "mission-1",
    targetSha256,
    providerId: "provider-a",
    findings: [],
    startedAt: settledAt,
    completedAt: settledAt,
    ...overrides,
  };
  return { ...unsigned, reportSha256: sha256Hex(Buffer.from(canonicalJson(unsigned), "utf8")) };
};

interface Fixture {
  store: SignerStore;
  confirmer: TransferConfirmer & { confirm: ReturnType<typeof vi.fn> };
  completion: CompletionService;
  settlementTxId: string;
  clock: { now: Date };
}

let fixture: () => Promise<Fixture>;
beforeAll(async () => {
  const poseidon = await poseidonHasher();
  fixture = async () => {
    const clock = { now: new Date(settledAt) };
    const store = memoryStore();
    stores.push(store);
    store.registerMissionPolicy(policy(), settledAt);
    const authorized = await new PaymentGate({
      store, accountId: consumerAccountId, privateKey: consumerKey, network: "hedera:testnet", poseidon, now: () => clock.now,
    }).authorize({ missionId: "mission-1", requirements: requirements(), nonce: "1" });
    const confirmer = { confirm: vi.fn(async () => ({ settledAt })) };
    const completion = new CompletionService({
      store,
      accountId: consumerAccountId,
      providerCallbackSecrets: { "provider-a": providerCallbackSecret },
      confirmer,
      now: () => clock.now,
    });
    return { store, confirmer, completion, settlementTxId: authorized.paymentAuthorization.transactionId, clock };
  };
});

const callback = (settlementTxId: string, body: object, timestamp: string, secret = providerCallbackSecret) => {
  const raw = Buffer.from(JSON.stringify(body), "utf8");
  const key = `mission-complete:${(body as { outcome: { missionId: string } }).outcome.missionId}:${(body as { report: { reportSha256: string } }).report.reportSha256}`;
  return {
    body: raw,
    headers: {
      "idempotency-key": key,
      "x-callback-timestamp": timestamp,
      "x-callback-signature": callbackSignature(secret, timestamp, key, raw),
    },
  };
};

const delivered = (settlementTxId: string, overrides: Record<string, unknown> = {}) => {
  const scan = report(overrides);
  return {
    outcome: { missionId: "mission-1", delivered: true, reportSha256: scan.reportSha256, settlementTxId, observedAt: settledAt },
    report: scan,
  };
};

describe("/internal/missions/complete", () => {
  it("accepts a provider-authenticated, ledger-confirmed completion once and acknowledges replays", async () => {
    const { completion, confirmer, settlementTxId, store } = await fixture();
    const body = delivered(settlementTxId);
    const first = callback(settlementTxId, body, "1789214400");

    // The MAC formula is the one the F06 provider computes.
    expect(first.headers["x-callback-signature"]).toBe(providerCallbackSignature(providerCallbackSecret, "1789214400", first.headers["idempotency-key"], first.body.toString("utf8")));

    await expect(completion.complete(first)).resolves.toEqual({ status: "accepted" });
    expect(confirmer.confirm).toHaveBeenCalledWith({
      transactionId: settlementTxId,
      payerAccountId: consumerAccountId,
      recipientAccountId: providerAccountId,
      amountTinybar: 1_000_000n,
    });
    expect(store.getCompletion("mission-1")).toMatchObject({ reportSha256: body.report.reportSha256, settlementTxId });

    // A resend keeps body and key, refreshes timestamp and MAC, and is answered
    // from the stored key even while the ledger view is unavailable.
    confirmer.confirm.mockRejectedValueOnce(new SignerError("settlement_unconfirmed", "Mirror unavailable"));
    await expect(completion.complete(callback(settlementTxId, body, "1789214405"))).resolves.toEqual({ status: "duplicate", code: "callback_duplicate" });
    expect(confirmer.confirm).toHaveBeenCalledTimes(1);
    // A different report under the same mission cannot create a second completion.
    await expect(completion.complete(callback(settlementTxId, delivered(settlementTxId, { completedAt: "2026-09-12T12:00:01.000Z" }), "1789214406")))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("rejects bad authentication before any state mutation", async () => {
    const { completion, confirmer, settlementTxId, store } = await fixture();
    const body = delivered(settlementTxId);
    const failure = async (input: ReturnType<typeof callback>, code: string) => {
      await expect(completion.complete(input)).rejects.toMatchObject({ code });
    };

    await failure(callback(settlementTxId, body, "1789214400", Buffer.alloc(32, 9)), "callback_auth_invalid");
    await failure(callback(settlementTxId, body, "1789214701"), "callback_auth_invalid");
    const tampered = callback(settlementTxId, body, "1789214400");
    await failure({ ...tampered, headers: { ...tampered.headers, "idempotency-key": `mission-complete:mission-1:${"0".repeat(64)}` } }, "callback_auth_invalid");
    await failure({ ...tampered, body: Buffer.from(tampered.body.toString("utf8").replace('"findings":[]', '"findings":[ ]'), "utf8") }, "callback_auth_invalid");
    // A schema-invalid body under an invalid MAC reveals nothing but the authentication failure.
    const invalidReport = { ...body, report: { ...body.report, findings: "not-a-list" } };
    await failure(callback(settlementTxId, invalidReport, "1789214400", Buffer.alloc(32, 9)), "callback_auth_invalid");
    // The same body under a valid MAC is a contract failure.
    await failure(callback(settlementTxId, invalidReport, "1789214400"), "report_schema_invalid");
    expect(confirmer.confirm).not.toHaveBeenCalled();
    expect(store.getCompletion("mission-1")).toBeUndefined();
  });

  it("rejects reports not bound to the stored mission, unauthorized settlements and unconfirmed ledgers", async () => {
    const { completion, confirmer, settlementTxId, store } = await fixture();
    const failure = async (body: object, code: string) => {
      await expect(completion.complete(callback(settlementTxId, body, "1789214400"))).rejects.toMatchObject({ code });
    };

    await failure(delivered(settlementTxId, { providerId: "provider-b" }), "report_binding_mismatch");
    await failure(delivered(settlementTxId, { targetSha256: "2".repeat(64) }), "report_binding_mismatch");
    const wrongHash = delivered(settlementTxId);
    wrongHash.report.reportSha256 = "3".repeat(64);
    wrongHash.outcome.reportSha256 = wrongHash.report.reportSha256;
    await failure(wrongHash, "report_binding_mismatch");
    await failure(delivered("0.0.3001@1789214400.000000009"), "report_binding_mismatch");
    expect(confirmer.confirm).not.toHaveBeenCalled();

    confirmer.confirm.mockRejectedValueOnce(new SignerError("settlement_unconfirmed", "Transfer is not yet visible"));
    await failure(delivered(settlementTxId), "settlement_unconfirmed");
    expect(store.getCompletion("mission-1")).toBeUndefined();
    await expect(completion.complete(callback(settlementTxId, delivered(settlementTxId), "1789214401"))).resolves.toEqual({ status: "accepted" });
  });
});

describe("/repay", () => {
  const prepared = (id: number, validUntil: number): PreparedRepayment => ({
    transactionId: `${consumerAccountId}@1789214400.00000000${id}`,
    transactionBase64: Buffer.from(`repayment-${id}`).toString("base64"),
    validUntil,
  });

  const funded = async () => {
    const f = await fixture();
    const credit = new CreditService({
      store: f.store,
      accountId: consumerAccountId,
      privateKey: consumerKey,
      lenderPublicKeys: { [lenderAccountId]: lenderKey.publicKey.toStringRaw() },
      confirmer: f.confirmer,
      now: () => settledAt,
    });
    const request = {
      id: "credit-1", missionId: "mission-1", borrowerAccountId: consumerAccountId, principalTinybar: "3000000",
      requestedTermSeconds: 3600, purposeHash: purposeHashFor("mission-1", targetSha256), createdAt: settledAt,
    };
    const { signature } = credit.signCreditRequest({ request });
    const terms = { id: "offer-1", requestId: "credit-1", lenderAccountId, principalTinybar: "3000000", feeTinybar: "30000", termSeconds: 3600, expiresAt: "2026-09-12T12:05:00.000Z" };
    const unsignedOffer = { ...terms, termsHash: termsHashFor(terms) };
    const offer = { ...unsignedOffer, signature: signDomain(lenderKey, CREDIT_SIGNATURE_DOMAINS.offer, unsignedOffer) };
    const signed = credit.signCreditAcceptance({ offer });
    const registration = {
      loanId: "loan-1", request: { ...request, signature }, offer, acceptance: signed.acceptance,
      signatures: { acceptance: signed.signature }, fundingTxId: `${lenderAccountId}@1789128000.000000001`,
    };
    await credit.registerLoan(lenderAccountId, registration);
    let sequence = 0;
    const ledger: RepaymentLedger & { prepare: ReturnType<typeof vi.fn>; submit: ReturnType<typeof vi.fn> } = {
      prepare: vi.fn(async () => prepared(++sequence, f.clock.now.getTime() + 180_000)),
      submit: vi.fn(async () => "success" as const),
    };
    const repayment = () => new RepaymentService({ store: f.store, accountId: consumerAccountId, ledger, confirmer: f.confirmer, now: () => f.clock.now });
    return { ...f, ledger, repayment, credit, registration };
  };

  const request = { missionId: "mission-1", loanId: "loan-1", idempotencyKey: "repayment:loan-1" };

  it("repays only a funded loan of a completed mission, from the stored terms, exactly once", async () => {
    const f = await funded();
    const service = f.repayment();
    await expect(service.repay(request)).rejects.toMatchObject({ code: "mission_not_repayable", status: 409 });
    await f.completion.complete(callback(f.settlementTxId, delivered(f.settlementTxId), "1789214400"));

    const result = await service.repay(request);
    expect(result.transactionId).toBe(`${consumerAccountId}@1789214400.000000001`);
    expect(f.ledger.prepare).toHaveBeenCalledWith({ from: consumerAccountId, to: lenderAccountId, amountTinybar: 3_030_000n, memo: "repayment:loan-1" });
    expect(f.ledger.submit).toHaveBeenCalledTimes(1);
    expect(f.store.getLoan("loan-1")).toMatchObject({ state: "repaid", repaymentTxId: result.transactionId });

    await expect(service.repay(request)).resolves.toEqual(result);
    expect(f.ledger.prepare).toHaveBeenCalledTimes(1);
    expect(f.ledger.submit).toHaveBeenCalledTimes(1);
    const types = listMissionEvents(f.store.database, "mission-1").map(event => event.type);
    expect(types).toEqual(["repayment-settled", "repayment-idempotency-hit"]);

    // A lender retrying a lost registration acknowledgement after repayment still succeeds.
    await expect(f.credit.registerLoan(lenderAccountId, f.registration)).resolves.toEqual({ loanId: "loan-1", state: "funded" });

    await expect(service.repay({ ...request, idempotencyKey: "repayment:loan-2" })).rejects.toThrow();
    await expect(service.repay({ ...request, loanId: "loan-2", idempotencyKey: "repayment:loan-2" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("reconciles an uncertain submission across restarts without a second transfer", async () => {
    const f = await funded();
    await f.completion.complete(callback(f.settlementTxId, delivered(f.settlementTxId), "1789214400"));
    f.ledger.submit.mockResolvedValueOnce("uncertain");

    await expect(f.repayment().repay(request)).rejects.toMatchObject({ code: "settlement_unconfirmed", status: 503 });
    expect(f.store.getRepayment("loan-1")).toMatchObject({ status: "pending", attempts: 1 });

    // Restart: a new service over the same store sees the ledger confirm the stored transaction.
    const result = await f.repayment().repay(request);
    expect(result.transactionId).toBe(`${consumerAccountId}@1789214400.000000001`);
    expect(f.ledger.prepare).toHaveBeenCalledTimes(1);
    expect(f.ledger.submit).toHaveBeenCalledTimes(1);
    expect(f.confirmer.confirm).toHaveBeenLastCalledWith({
      transactionId: result.transactionId, payerAccountId: consumerAccountId, recipientAccountId: lenderAccountId, amountTinybar: 3_030_000n,
    });
    expect(f.store.getLoan("loan-1")?.state).toBe("repaid");
  });

  it("resubmits the same bytes while valid and only builds a fresh transaction after the window and grace", async () => {
    const f = await funded();
    await f.completion.complete(callback(f.settlementTxId, delivered(f.settlementTxId), "1789214400"));
    f.ledger.submit.mockResolvedValueOnce("uncertain").mockResolvedValueOnce("uncertain");
    f.confirmer.confirm.mockRejectedValue(new SignerError("settlement_unconfirmed", "Transfer is not yet visible"));
    const service = f.repayment();

    await expect(service.repay(request)).rejects.toMatchObject({ code: "settlement_unconfirmed" });
    await expect(service.repay(request)).rejects.toMatchObject({ code: "settlement_unconfirmed" });
    expect(f.ledger.submit).toHaveBeenNthCalledWith(2, Buffer.from("repayment-1").toString("base64"));
    expect(f.ledger.prepare).toHaveBeenCalledTimes(1);

    f.clock.now = new Date(f.clock.now.getTime() + 180_000 + 1);
    await expect(service.repay(request)).rejects.toMatchObject({ code: "settlement_unconfirmed" });
    expect(f.ledger.prepare).toHaveBeenCalledTimes(1);

    f.clock.now = new Date(f.clock.now.getTime() + REPAYMENT_FAILURE_GRACE_MS);
    const result = await service.repay(request);
    expect(f.ledger.prepare).toHaveBeenCalledTimes(2);
    expect(result.transactionId).toBe(`${consumerAccountId}@1789214400.000000002`);
    expect(f.store.getLoan("loan-1")?.state).toBe("repaid");
  });

  it("treats a failed receipt as terminal for that transaction and never marks the loan repaid", async () => {
    const f = await funded();
    await f.completion.complete(callback(f.settlementTxId, delivered(f.settlementTxId), "1789214400"));
    f.ledger.submit.mockResolvedValueOnce("failed");
    const service = f.repayment();

    await expect(service.repay(request)).rejects.toMatchObject({ code: "settlement_unconfirmed" });
    expect(f.store.getRepayment("loan-1")?.status).toBe("failed");
    expect(f.store.getLoan("loan-1")?.state).toBe("funded");

    await expect(service.repay(request)).resolves.toMatchObject({ transactionId: `${consumerAccountId}@1789214400.000000002` });
    expect(f.ledger.prepare).toHaveBeenCalledTimes(2);
  });
});
