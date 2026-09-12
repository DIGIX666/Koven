import { CREDIT_SIGNATURE_DOMAINS, type ProofBundle } from "@koven/domain";
import type { HttpRequest } from "@koven/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalHash, signDomain, verifyDomain, withoutSignature } from "../src/canonical.js";
import { CreditService, purposeHashFor, termsHashFor } from "../src/credit.js";
import { SignerError } from "../src/errors.js";
import type { TransferConfirmer } from "../src/ledger.js";
import type { SignerStore, WireOffer } from "../src/store.js";
import {
  consumerAccountId,
  consumerKey,
  lenderAccountId,
  lenderKey,
  memoryStore,
  policy,
  targetSha256,
} from "./helpers.js";

const now = "2026-09-12T12:00:00.000Z";
const fundingTxId = `${lenderAccountId}@1789128000.000000001`;
const stores: SignerStore[] = [];
afterEach(() => stores.splice(0).forEach(store => store.close()));

const unsignedRequest = (overrides: Partial<HttpRequest<"signCreditRequest">["request"]> = {}) => ({
  id: "credit-1",
  missionId: "mission-1",
  borrowerAccountId: consumerAccountId,
  principalTinybar: "3000000",
  requestedTermSeconds: 3600,
  purposeHash: purposeHashFor("mission-1", targetSha256),
  createdAt: now,
  ...overrides,
});

/** What the F08 lender does: sign the complete unsigned offer with its own key. */
const lenderOffer = (overrides: Partial<WireOffer> = {}): WireOffer => {
  const terms = {
    id: "offer-1",
    requestId: "credit-1",
    lenderAccountId,
    principalTinybar: "3000000",
    feeTinybar: "30000",
    termSeconds: 3600,
    expiresAt: "2026-09-12T12:05:00.000Z",
    ...overrides,
  };
  const unsigned = { ...terms, termsHash: overrides.termsHash ?? termsHashFor(terms) };
  return { ...unsigned, signature: overrides.signature ?? signDomain(lenderKey, CREDIT_SIGNATURE_DOMAINS.offer, unsigned) };
};

const service = (confirmer: TransferConfirmer = { confirm: vi.fn(async () => ({ settledAt: now })) }) => {
  const store = memoryStore();
  stores.push(store);
  store.registerMissionPolicy(policy(), now);
  const credit = new CreditService({
    store,
    accountId: consumerAccountId,
    privateKey: consumerKey,
    lenderPublicKeys: { [lenderAccountId]: lenderKey.publicKey.toStringRaw() },
    confirmer,
    now: () => now,
  });
  return { store, credit, confirmer };
};

const failure = (run: () => unknown, code: string) => {
  expect(run).toThrowError(SignerError);
  try { run(); } catch (error) { expect((error as SignerError).code).toBe(code); }
};

describe("typed credit request signing", () => {
  it("signs only a request bound to the borrower's provisioned mission", () => {
    const { credit, store } = service();
    const { signature } = credit.signCreditRequest({ request: unsignedRequest() });

    expect(verifyDomain(consumerKey.publicKey, CREDIT_SIGNATURE_DOMAINS.request, unsignedRequest(), signature)).toBe(true);
    expect(store.getCreditRequest("credit-1")?.signature).toBe(signature);
    expect(credit.signCreditRequest({ request: unsignedRequest() }).signature).toBe(signature);
  });

  it("rejects other borrowers, unprovisioned missions, wrong purpose, invalid terms and reused ids", () => {
    const { credit } = service();
    failure(() => credit.signCreditRequest({ request: unsignedRequest({ borrowerAccountId: "0.0.1002" }) }), "mission_policy_mismatch");
    failure(() => credit.signCreditRequest({ request: unsignedRequest({ missionId: "mission-9" }) }), "mission_policy_missing");
    failure(() => credit.signCreditRequest({ request: unsignedRequest({ purposeHash: "0".repeat(64) }) }), "mission_policy_mismatch");
    failure(() => credit.signCreditRequest({ request: unsignedRequest({ principalTinybar: "0" }) }), "request_invalid");
    failure(() => credit.signCreditRequest({ request: unsignedRequest({ principalTinybar: "5000001" }) }), "request_invalid");
    expect(() => credit.signCreditRequest({ request: { ...unsignedRequest(), extra: 1 } as never })).toThrow();
    credit.signCreditRequest({ request: unsignedRequest() });
    failure(() => credit.signCreditRequest({ request: unsignedRequest({ principalTinybar: "2000000" }) }), "idempotency_conflict");
  });
});

describe("typed credit acceptance signing", () => {
  it("constructs and signs one acceptance per mission from a verified offer", () => {
    const { credit, store } = service();
    credit.signCreditRequest({ request: unsignedRequest() });
    const offer = lenderOffer();
    const signed = credit.signCreditAcceptance({ offer });

    expect(signed.acceptance).toEqual({
      requestId: "credit-1",
      missionId: "mission-1",
      borrowerAccountId: consumerAccountId,
      lenderAccountId,
      offerId: "offer-1",
      termsHash: offer.termsHash,
      expiresAt: offer.expiresAt,
    });
    expect(verifyDomain(consumerKey.publicKey, CREDIT_SIGNATURE_DOMAINS.acceptance, signed.acceptance, signed.signature)).toBe(true);
    expect(credit.signCreditAcceptance({ offer })).toEqual(signed);
    expect(store.getAcceptance("mission-1")?.offer).toEqual(offer);

    failure(() => credit.signCreditAcceptance({ offer: lenderOffer({ id: "offer-2", feeTinybar: "1" }) }), "credit_acceptance_conflict");
  });

  it("binds optional M3 evidence hashes into the signed acceptance", () => {
    const { credit } = service();
    credit.signCreditRequest({ request: unsignedRequest() });
    const paymentIntent = { amountTinybar: "1000000", recipientAccountId: "0.0.2001", nonce: "1", resourceHash: "a".repeat(64), missionId: "mission-1" };
    const paymentProofBundle: ProofBundle = {
      proof: { protocol: "groth16", curve: "bn128", pi_a: ["1", "2", "1"], pi_b: [["1", "2"], ["3", "4"], ["1", "0"]], pi_c: ["1", "2", "1"] },
      publicSignals: ["1", "2", "1000000"],
      vkeyHash: "b".repeat(64),
      circuitId: "koven-policy-v1",
    };
    const signed = credit.signCreditAcceptance({ offer: lenderOffer(), paymentIntent, paymentProofBundle });
    expect(signed.acceptance.paymentIntentHash).toBe(canonicalHash(paymentIntent));
    expect(signed.acceptance.paymentProofBundleHash).toBe(canonicalHash(paymentProofBundle));
  });

  it("rejects offers in the frozen order: signature, request, expiry, principal, terms, term", () => {
    const { credit } = service();
    credit.signCreditRequest({ request: unsignedRequest() });
    failure(() => credit.signCreditAcceptance({ offer: lenderOffer({ signature: "0".repeat(128) }) }), "offer_signature_invalid");
    failure(() => credit.signCreditAcceptance({ offer: lenderOffer({ lenderAccountId: "0.0.4002" }) }), "offer_signature_invalid");
    failure(() => credit.signCreditAcceptance({ offer: lenderOffer({ requestId: "credit-2" }) }), "request_invalid");
    failure(() => credit.signCreditAcceptance({ offer: lenderOffer({ expiresAt: "2026-09-12T11:59:59.000Z" }) }), "offer_expired");
    failure(() => credit.signCreditAcceptance({ offer: lenderOffer({ principalTinybar: "2999999" }) }), "request_invalid");
    failure(() => credit.signCreditAcceptance({ offer: lenderOffer({ termsHash: "0".repeat(64) }) }), "request_invalid");
    failure(() => credit.signCreditAcceptance({ offer: lenderOffer({ termSeconds: 7200 }) }), "request_invalid");
    failure(() => credit.signCreditAcceptance({ offer: lenderOffer({ principalTinybar: "5000001" }) }), "mission_policy_mismatch");
    // An altered field under a stale signature is a signature failure, not a terms failure.
    const genuine = lenderOffer();
    failure(() => credit.signCreditAcceptance({ offer: { ...genuine, feeTinybar: "1" } }), "offer_signature_invalid");
  });
});

describe("lender-authenticated loan registration", () => {
  const registration = (credit: CreditService, overrides: Partial<HttpRequest<"registerLoan">> = {}): HttpRequest<"registerLoan"> => {
    const { signature } = credit.signCreditRequest({ request: unsignedRequest() });
    const offer = lenderOffer();
    const signed = credit.signCreditAcceptance({ offer });
    return {
      loanId: "loan-1",
      request: { ...unsignedRequest(), signature },
      offer,
      acceptance: signed.acceptance,
      signatures: { acceptance: signed.signature },
      fundingTxId,
      ...overrides,
    };
  };

  it("registers a funded loan once after confirming the funding on the ledger", async () => {
    const { credit, store, confirmer } = service();
    const body = registration(credit);

    await expect(credit.registerLoan(lenderAccountId, body)).resolves.toEqual({ loanId: "loan-1", state: "funded" });
    expect(confirmer.confirm).toHaveBeenCalledWith({
      transactionId: fundingTxId,
      payerAccountId: lenderAccountId,
      recipientAccountId: consumerAccountId,
      amountTinybar: 3_000_000n,
    });
    expect(store.getLoan("loan-1")).toMatchObject({ state: "funded", fundingTxId, principalTinybar: 3_000_000n, feeTinybar: 30_000n });

    await expect(credit.registerLoan(lenderAccountId, body)).resolves.toEqual({ loanId: "loan-1", state: "funded" });
    await expect(credit.registerLoan(lenderAccountId, { ...body, loanId: "loan-2" })).rejects.toMatchObject({ code: "loan_registration_conflict" });
    await expect(credit.registerLoan(lenderAccountId, { ...body, fundingTxId: `${lenderAccountId}@1789128000.000000002` }))
      .rejects.toMatchObject({ code: "loan_registration_conflict" });
  });

  it("rejects unauthenticated lenders, altered documents and unconfirmed or mismatched funding", async () => {
    const pending = new SignerError("settlement_unconfirmed", "Transfer is not yet visible");
    const confirmer = { confirm: vi.fn().mockRejectedValueOnce(pending).mockRejectedValueOnce(new SignerError("funding_mismatch", "wrong amount")).mockResolvedValue({ settledAt: now }) };
    const { credit, store } = service(confirmer);
    const body = registration(credit);

    await expect(credit.registerLoan("0.0.4002", body)).rejects.toMatchObject({ code: "auth_invalid", status: 401 });
    await expect(credit.registerLoan(lenderAccountId, { ...body, signatures: { acceptance: "0".repeat(128) } }))
      .rejects.toMatchObject({ code: "credit_acceptance_invalid", status: 401 });
    await expect(credit.registerLoan(lenderAccountId, { ...body, acceptance: { ...body.acceptance, termsHash: "0".repeat(64) } }))
      .rejects.toMatchObject({ code: "credit_acceptance_invalid" });
    await expect(credit.registerLoan(lenderAccountId, { ...body, offer: { ...body.offer, feeTinybar: "1" } }))
      .rejects.toMatchObject({ code: "credit_acceptance_invalid" });
    await expect(credit.registerLoan(lenderAccountId, { ...body, request: { ...body.request, principalTinybar: "1" } }))
      .rejects.toMatchObject({ code: "credit_acceptance_invalid" });
    expect(confirmer.confirm).not.toHaveBeenCalled();

    await expect(credit.registerLoan(lenderAccountId, body)).rejects.toMatchObject({ code: "settlement_unconfirmed", status: 503 });
    await expect(credit.registerLoan(lenderAccountId, body)).rejects.toMatchObject({ code: "funding_mismatch", status: 409 });
    expect(store.getLoan("loan-1")).toBeUndefined();
    await expect(credit.registerLoan(lenderAccountId, body)).resolves.toMatchObject({ state: "funded" });
    expect(withoutSignature(body.offer)).not.toHaveProperty("signature");
  });
});
