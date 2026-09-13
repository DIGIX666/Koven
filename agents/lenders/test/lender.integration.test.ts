import {
  signCreditAcceptance,
  validateCreditOffer,
} from "@koven/credit-protocol";
import { AgentMode } from "@hashgraph/hedera-agent-kit";
import { openDatabase } from "@koven/persistence";
import {
  CreditAcceptResponseSchema,
  CreditOfferSchema,
  ErrorResponseSchema,
  MissionPolicyResponseSchema,
} from "@koven/schemas";
import { afterEach, describe, expect, it } from "vitest";

import { AgentKitFundingGateway, ConservativeLenderPolicy, type FundingTransfer } from "../src/index.js";
import {
  acceptanceWire,
  borrowerKey,
  closeRuntimes,
  databases,
  FakeFundingGateway,
  FakeRegistrationClient,
  lenderKey,
  listen,
  now,
  offerDomain,
  policy,
  postAcceptance,
  quote,
  registerPolicy,
  runtime,
  signedRequest,
  transactionId,
} from "./helpers.js";

class BlockingFundingGateway extends FakeFundingGateway {
  readonly started: Promise<void>;
  private signalStarted!: () => void;
  private readonly released: Promise<void>;
  private signalReleased!: () => void;

  constructor() {
    super();
    this.started = new Promise(resolve => { this.signalStarted = resolve; });
    this.released = new Promise(resolve => { this.signalReleased = resolve; });
  }

  release(): void {
    this.signalReleased();
  }

  override async transfer(input: FundingTransfer): Promise<{ transactionId: string }> {
    this.transfers.push({
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      amountTinybar: input.amountTinybar,
      memo: input.memo,
    });
    this.signalStarted();
    await this.released;
    input.onPrepared(transactionId);
    return { transactionId };
  }
}

afterEach(closeRuntimes);

describe("first conservative lender", () => {
  it("authenticates and idempotently registers a mission policy", async () => {
    const test = runtime();
    const baseUrl = await listen(test.app);

    const unauthorized = await fetch(`${baseUrl}/internal/missions/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(policy()),
    });
    expect(unauthorized.status).toBe(401);

    const first = await registerPolicy(baseUrl);
    expect(first.status).toBe(200);
    expect(MissionPolicyResponseSchema.parse(await first.json())).toEqual({
      missionId: "mission-1",
      status: "registered",
    });
    expect((await registerPolicy(baseUrl)).status).toBe(200);
    const conflict = await registerPolicy(baseUrl, policy({ spendingCapTinybar: "999" }));
    expect(conflict.status).toBe(409);
    expect(ErrorResponseSchema.parse(await conflict.json()).code).toBe("mission_policy_conflict");
  });

  it("returns an independently verifiable quote bound to registered policy", async () => {
    const test = runtime();
    const baseUrl = await listen(test.app);
    await registerPolicy(baseUrl);
    const result = await quote(baseUrl);

    expect(result.response.status).toBe(200);
    const offer = offerDomain(CreditOfferSchema.parse(await result.response.json()));
    expect(() => validateCreditOffer(offer, result.request, lenderKey.publicKey, now)).not.toThrow();
    expect(offer.principalTinybar).toBe(result.request.principalTinybar);
    expect(offer.feeTinybar).toBe(5n);

    const duplicate = await quote(baseUrl, result.request);
    expect(await duplicate.response.json()).toEqual({
      ...offer,
      principalTinybar: "100",
      feeTinybar: "5",
    });
  });

  it("declines policy limits and rejects invalid requests before producing an offer", async () => {
    const test = runtime({ reputation: 0.5 });
    const baseUrl = await listen(test.app);
    await registerPolicy(baseUrl);
    expect((await quote(baseUrl)).response.status).toBe(204);

    const missingPolicy = runtime();
    const secondUrl = await listen(missingPolicy.app);
    expect((await quote(secondUrl)).response.status).toBe(403);

    const valid = signedRequest();
    const tampered = { ...valid, principalTinybar: 101n };
    const invalid = await quote(baseUrl, tampered);
    expect(invalid.response.status).toBe(401);
    expect(ErrorResponseSchema.parse(await invalid.response.json()).code)
      .toBe("credit_request_signature_invalid");
  });

  it("declines non-finite reputation and repayment terms that overflow uint64", () => {
    const conservative = new ConservativeLenderPolicy({
      maxPrincipalTinybar: (1n << 64n) - 1n,
      maxTermSeconds: 7_200,
      minReputationScore: 0.8,
      feeBps: 500,
    });

    expect(conservative.evaluate(signedRequest(), Number.NaN)).toBeUndefined();
    expect(conservative.evaluate(
      signedRequest({ principalTinybar: (1n << 64n) - 1n }),
      0.9,
    )).toBeUndefined();
  });

  it("rejects conflicting reuse of a signed request ID", async () => {
    const test = runtime();
    const baseUrl = await listen(test.app);
    await registerPolicy(baseUrl);
    expect((await quote(baseUrl)).response.status).toBe(200);

    const replacement = signedRequest({ principalTinybar: 101n });
    const conflict = await quote(baseUrl, replacement);
    expect(conflict.response.status).toBe(409);
    expect(ErrorResponseSchema.parse(await conflict.response.json()).code)
      .toBe("idempotency_conflict");
  });

  it("funds verified terms once and registers the loan before returning success", async () => {
    const test = runtime();
    const baseUrl = await listen(test.app);
    await registerPolicy(baseUrl);
    const quoted = await quote(baseUrl);
    const offer = offerDomain(CreditOfferSchema.parse(await quoted.response.json()));
    const accepted = acceptanceWire(quoted.request, offer);

    const first = await postAcceptance(baseUrl, accepted);
    expect(first.status).toBe(200);
    expect(CreditAcceptResponseSchema.parse(await first.json())).toEqual({ fundingTxId: transactionId });
    expect(test.gateway.transfers).toEqual([{
      fromAccountId: "0.0.20",
      toAccountId: "0.0.10",
      amountTinybar: 100n,
      memo: expect.stringMatching(/^fund:/),
    }]);
    expect(test.registration.requests).toHaveLength(1);

    const duplicate = await postAcceptance(baseUrl, accepted);
    expect(duplicate.status).toBe(200);
    expect(test.gateway.transfers).toHaveLength(1);
    expect(test.registration.requests).toHaveLength(1);
  });

  it("persists the replacement transaction ID returned after an SDK retry", async () => {
    const gateway = new FakeFundingGateway();
    gateway.preparedTransactionId = "0.0.20@1789128000.000000001";
    gateway.returnedTransactionId = "0.0.20@1789128001.000000002";
    const test = runtime({ gateway });
    const baseUrl = await listen(test.app);
    await registerPolicy(baseUrl);
    const quoted = await quote(baseUrl);
    const offer = offerDomain(CreditOfferSchema.parse(await quoted.response.json()));

    const response = await postAcceptance(
      baseUrl,
      acceptanceWire(quoted.request, offer),
    );

    expect(response.status).toBe(200);
    expect(CreditAcceptResponseSchema.parse(await response.json())).toEqual({
      fundingTxId: gateway.returnedTransactionId,
    });
    expect(test.store.getFundingByOffer(offer.id)).toMatchObject({
      transactionId: gateway.returnedTransactionId,
      status: "registered",
    });
  });

  it("serializes concurrent acceptance attempts before preparing a transfer", async () => {
    const gateway = new BlockingFundingGateway();
    const test = runtime({ gateway });
    const baseUrl = await listen(test.app);
    await registerPolicy(baseUrl);
    const quoted = await quote(baseUrl);
    const offer = offerDomain(CreditOfferSchema.parse(await quoted.response.json()));
    const accepted = acceptanceWire(quoted.request, offer);

    const first = postAcceptance(baseUrl, accepted);
    await gateway.started;
    const concurrent = await postAcceptance(baseUrl, accepted);
    expect(concurrent.status).toBe(503);
    expect(ErrorResponseSchema.parse(await concurrent.json()).code)
      .toBe("settlement_unconfirmed");

    gateway.release();
    expect((await first).status).toBe(200);
    expect(gateway.transfers).toHaveLength(1);
  });

  it("rejects conflicting reuse of an offer funding reservation", () => {
    const test = runtime();
    test.store.reserveFunding("offer-1", "a".repeat(64), "{}", now);

    let conflict: unknown;
    try {
      test.store.reserveFunding("offer-1", "b".repeat(64), "{}", now);
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toMatchObject({ code: "credit_acceptance_conflict" });
  });

  it("fences an expired preparation claim before a restarted worker submits", () => {
    const test = runtime();
    const funding = test.store.reserveFunding("offer-1", "a".repeat(64), "{}", now);
    expect(test.store.claimFundingSubmission(
      funding.id,
      "worker-a",
      now,
      "2026-09-11T11:59:30.000Z",
    )).toBe(true);
    expect(test.store.claimFundingSubmission(
      funding.id,
      "worker-b",
      "2026-09-11T12:01:00.000Z",
      "2026-09-11T12:00:30.000Z",
    )).toBe(true);

    expect(() => test.store.setFundingTransaction(
      funding.id,
      "worker-a",
      transactionId,
      "2026-09-11T12:01:00.000Z",
    )).toThrow("another transaction");
    expect(() => test.store.setFundingTransaction(
      funding.id,
      "worker-b",
      transactionId,
      "2026-09-11T12:01:00.000Z",
    )).not.toThrow();
  });

  it("rejects borrower substitution and caller-supplied funding amounts before transfer", async () => {
    const test = runtime();
    const baseUrl = await listen(test.app);
    await registerPolicy(baseUrl);
    const quoted = await quote(baseUrl);
    const offer = offerDomain(CreditOfferSchema.parse(await quoted.response.json()));
    const substituted = signCreditAcceptance({
      ...acceptanceWire(quoted.request, offer).acceptance,
      borrowerAccountId: "0.0.99",
    }, borrowerKey);
    expect((await postAcceptance(baseUrl, substituted)).status).toBe(401);
    expect(test.gateway.transfers).toHaveLength(0);

    const withAmount = { ...acceptanceWire(quoted.request, offer), amountTinybar: "1" };
    expect((await postAcceptance(baseUrl, withAmount)).status).toBe(400);
    expect(test.gateway.transfers).toHaveLength(0);
  });

  it("rejects an expired acceptance before funding", async () => {
    let current = now;
    const test = runtime({ clock: () => current });
    const baseUrl = await listen(test.app);
    await registerPolicy(baseUrl);
    const quoted = await quote(baseUrl);
    const offer = offerDomain(CreditOfferSchema.parse(await quoted.response.json()));
    current = "2026-09-11T12:06:00.000Z";

    const response = await postAcceptance(baseUrl, acceptanceWire(quoted.request, offer));
    expect(response.status).toBe(409);
    expect(ErrorResponseSchema.parse(await response.json()).code).toBe("offer_expired");
    expect(test.gateway.transfers).toHaveLength(0);
  });

  it("rejects oversized transport bodies before processing a quote", async () => {
    const test = runtime();
    const baseUrl = await listen(test.app);
    const response = await fetch(`${baseUrl}/credit/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(2_097_152) }),
    });

    expect(response.status).toBe(413);
    expect(ErrorResponseSchema.parse(await response.json()).code).toBe("source_too_large");
  });

  it("returns request_invalid for malformed JSON", async () => {
    const test = runtime();
    const baseUrl = await listen(test.app);
    const response = await fetch(`${baseUrl}/credit/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
    expect(ErrorResponseSchema.parse(await response.json())).toEqual({
      code: "request_invalid",
      detail: "Request body contains malformed JSON",
    });
  });

  it("reconciles a persisted uncertain transaction after restart without funding twice", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const firstGateway = new FakeFundingGateway();
    firstGateway.failAfterPrepare = true;
    const first = runtime({ database, gateway: firstGateway });
    const firstUrl = await listen(first.app);
    await registerPolicy(firstUrl);
    const quoted = await quote(firstUrl);
    const offer = offerDomain(CreditOfferSchema.parse(await quoted.response.json()));
    const accepted = acceptanceWire(quoted.request, offer);
    const uncertain = await postAcceptance(firstUrl, accepted);
    expect(uncertain.status).toBe(503);
    expect(firstGateway.transfers).toHaveLength(1);

    const resumedGateway = new FakeFundingGateway();
    const resumed = runtime({ database, gateway: resumedGateway });
    const resumedUrl = await listen(resumed.app);
    const result = await postAcceptance(resumedUrl, accepted);
    expect(result.status).toBe(200);
    expect(resumedGateway.transfers).toHaveLength(0);
    expect(resumedGateway.reconciliations).toBe(1);
  });

  it("keeps registration retryable without triggering another transfer", async () => {
    const registration = new FakeRegistrationClient();
    registration.failures = 1;
    const test = runtime({ registration });
    const baseUrl = await listen(test.app);
    await registerPolicy(baseUrl);
    const quoted = await quote(baseUrl);
    const offer = offerDomain(CreditOfferSchema.parse(await quoted.response.json()));
    const accepted = acceptanceWire(quoted.request, offer);

    expect((await postAcceptance(baseUrl, accepted)).status).toBe(503);
    expect((await postAcceptance(baseUrl, accepted)).status).toBe(200);
    expect(test.gateway.transfers).toHaveLength(1);
    expect(registration.requests).toHaveLength(2);
  });

  it("does not mark a failed pre-submission funding attempt as confirmed", async () => {
    const gateway = new FakeFundingGateway();
    gateway.failBeforePrepare = true;
    const test = runtime({ gateway });
    const baseUrl = await listen(test.app);
    await registerPolicy(baseUrl);
    const quoted = await quote(baseUrl);
    const offer = offerDomain(CreditOfferSchema.parse(await quoted.response.json()));

    expect((await postAcceptance(baseUrl, acceptanceWire(quoted.request, offer))).status).toBe(500);
    expect(test.store.getFundingByOffer(offer.id)).toMatchObject({ status: "reserved" });
  });

  it("configures the production funding gateway for direct autonomous tool use", () => {
    const client = {} as ConstructorParameters<typeof AgentKitFundingGateway>[0];
    const reconciler = new FakeFundingGateway();
    const gateway = new AgentKitFundingGateway(client, "0.0.20", reconciler, "0.0.123");

    expect(gateway.mode).toBe(AgentMode.AUTONOMOUS);
    expect(gateway.toolName).toBe("transfer_hbar_tool");
    expect(gateway.auditTopicId).toBe("0.0.123");
  });
});
