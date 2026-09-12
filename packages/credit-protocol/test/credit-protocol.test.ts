import { ErrorCode, type CreditAcceptance, type UnsignedCreditRequest } from "@koven/domain";
import { PrivateKey } from "@koven/hedera";
import { describe, expect, it } from "vitest";

import {
  canonicalHash,
  canonicalJson,
  computeTermsHash,
  CreditProtocolError,
  repaymentTerms,
  signCreditAcceptance,
  signCreditOffer,
  signCreditRequest,
  validateAcceptanceEvidence,
  validateCreditAcceptance,
  validateCreditOffer,
  verifyCreditRequest,
  type UnsignedCreditOffer,
} from "../src/index.js";

const now = "2026-09-11T12:00:00.000Z";
const borrowerKey = PrivateKey.generateECDSA();
const lenderKey = PrivateKey.generateECDSA();

const unsignedRequest = (overrides: Partial<UnsignedCreditRequest> = {}): UnsignedCreditRequest => ({
  id: "request-1",
  missionId: "mission-1",
  borrowerAccountId: "0.0.10",
  principalTinybar: 100n,
  requestedTermSeconds: 3_600,
  purposeHash: "a".repeat(64),
  createdAt: now,
  ...overrides,
});

const unsignedOffer = (overrides: Partial<UnsignedCreditOffer> = {}): UnsignedCreditOffer => {
  const terms = {
    id: "offer-1",
    requestId: "request-1",
    lenderAccountId: "0.0.20",
    principalTinybar: 100n,
    feeTinybar: 5n,
    termSeconds: 3_600,
    expiresAt: "2026-09-11T12:10:00.000Z",
    ...overrides,
  };
  return { ...terms, termsHash: overrides.termsHash ?? computeTermsHash(terms) };
};

const acceptanceFor = (
  request = signCreditRequest(unsignedRequest(), borrowerKey),
  offer = signCreditOffer(unsignedOffer(), lenderKey),
  overrides: Partial<CreditAcceptance> = {},
): CreditAcceptance => ({
  requestId: request.id,
  missionId: request.missionId,
  borrowerAccountId: request.borrowerAccountId,
  lenderAccountId: offer.lenderAccountId,
  offerId: offer.id,
  termsHash: offer.termsHash,
  expiresAt: offer.expiresAt,
  ...overrides,
});

const expectCode = (callback: () => void, code: string) => {
  try {
    callback();
    throw new Error("Expected credit validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(CreditProtocolError);
    expect((error as CreditProtocolError).code).toBe(code);
  }
};

describe("signed credit protocol", () => {
  it("canonicalizes reordered keys and bigint values identically", () => {
    const left = { z: 1, amount: 18_446_744_073_709_551_615n, nested: { b: 2, a: 1 } };
    const right = { nested: { a: 1, b: 2 }, amount: 18_446_744_073_709_551_615n, z: 1 };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(canonicalHash(left)).toBe(canonicalHash(right));
    expect(canonicalJson(left)).toContain('"18446744073709551615"');
  });

  it("rejects ambiguous array entries and unsafe JSON integers", () => {
    expect(() => canonicalJson([1, undefined])).toThrow("omitted array entries");
    expect(() => canonicalJson([Number.MAX_SAFE_INTEGER + 1])).toThrow("unsafe integer");
  });

  it("signs and independently verifies a request, offer and acceptance", () => {
    const request = signCreditRequest(unsignedRequest(), borrowerKey);
    const offer = signCreditOffer(unsignedOffer(), lenderKey);
    const signedAcceptance = signCreditAcceptance(acceptanceFor(request, offer), borrowerKey);

    expect(() => verifyCreditRequest(request, borrowerKey.publicKey)).not.toThrow();
    expect(() => validateCreditOffer(offer, request, lenderKey.publicKey, now)).not.toThrow();
    expect(() => validateCreditAcceptance(
      signedAcceptance,
      request,
      offer,
      borrowerKey.publicKey,
      now,
    )).not.toThrow();
  });

  it("invalidates signatures after any signed request or acceptance field changes", () => {
    const request = signCreditRequest(unsignedRequest(), borrowerKey);
    expectCode(
      () => verifyCreditRequest({ ...request, principalTinybar: 101n }, borrowerKey.publicKey),
      ErrorCode.CREDIT_REQUEST_SIGNATURE_INVALID,
    );

    const offer = signCreditOffer(unsignedOffer(), lenderKey);
    expectCode(
      () => validateCreditOffer({ ...offer, feeTinybar: 6n }, request, lenderKey.publicKey, now),
      ErrorCode.OFFER_SIGNATURE_INVALID,
    );
    const accepted = signCreditAcceptance(acceptanceFor(request, offer), borrowerKey);
    expectCode(
      () => validateCreditAcceptance(
        { ...accepted, acceptance: { ...accepted.acceptance, offerId: "offer-2" } },
        request,
        offer,
        borrowerKey.publicKey,
        now,
      ),
      ErrorCode.CREDIT_ACCEPTANCE_INVALID,
    );
  });

  it("checks signature before expiry and the remaining offer rules in protocol order", () => {
    const request = signCreditRequest(unsignedRequest(), borrowerKey);
    const expired = signCreditOffer(unsignedOffer({ expiresAt: "2026-09-11T11:59:00.000Z" }), lenderKey);
    expectCode(
      () => validateCreditOffer({ ...expired, signature: "0".repeat(128) }, request, lenderKey.publicKey, now),
      ErrorCode.OFFER_SIGNATURE_INVALID,
    );
    expectCode(
      () => validateCreditOffer(expired, request, lenderKey.publicKey, now),
      ErrorCode.OFFER_EXPIRED,
    );

    const otherRequest = signCreditOffer(unsignedOffer({ requestId: "request-2" }), lenderKey);
    expectCode(
      () => validateCreditOffer(otherRequest, request, lenderKey.publicKey, now),
      ErrorCode.REQUEST_INVALID,
    );

    const insufficient = signCreditOffer(unsignedOffer({ principalTinybar: 99n }), lenderKey);
    expectCode(
      () => validateCreditOffer(insufficient, request, lenderKey.publicKey, now),
      ErrorCode.REQUEST_INVALID,
    );

    const wrongHash = signCreditOffer(unsignedOffer({ termsHash: "f".repeat(64) }), lenderKey);
    expectCode(
      () => validateCreditOffer(wrongHash, request, lenderKey.publicKey, now),
      ErrorCode.REQUEST_INVALID,
    );

    const wrongTerm = signCreditOffer(unsignedOffer({ termSeconds: 1_800 }), lenderKey);
    expectCode(
      () => validateCreditOffer(wrongTerm, request, lenderKey.publicKey, now),
      ErrorCode.REQUEST_INVALID,
    );
  });

  it("rejects an acceptance that is rebound to another lender or offer", () => {
    const request = signCreditRequest(unsignedRequest(), borrowerKey);
    const offer = signCreditOffer(unsignedOffer(), lenderKey);
    const rebound = signCreditAcceptance(
      acceptanceFor(request, offer, { lenderAccountId: "0.0.30" }),
      borrowerKey,
    );

    expectCode(
      () => validateCreditAcceptance(rebound, request, offer, borrowerKey.publicKey, now),
      ErrorCode.CREDIT_ACCEPTANCE_INVALID,
    );
  });

  it("requires M3 payment intent and proof hashes to remain paired", () => {
    expectCode(
      () => signCreditAcceptance(
        acceptanceFor(undefined, undefined, { paymentIntentHash: "a".repeat(64) }),
        borrowerKey,
      ),
      ErrorCode.CREDIT_ACCEPTANCE_INVALID,
    );
  });

  it("binds optional M3 wire evidence to its signed canonical hashes", () => {
    const intent = {
      amountTinybar: "100",
      recipientAccountId: "0.0.30",
      nonce: "1",
      resourceHash: "a".repeat(64),
      missionId: "mission-1",
    };
    const bundle = {
      proof: { protocol: "groth16", curve: "bn128" },
      publicSignals: ["1", "1", "100"],
      vkeyHash: "b".repeat(64),
      circuitId: "koven-policy-v1",
    };
    const acceptance = acceptanceFor(undefined, undefined, {
      paymentIntentHash: canonicalHash(intent),
      paymentProofBundleHash: canonicalHash(bundle),
    });

    expect(() => validateAcceptanceEvidence(acceptance, intent, bundle)).not.toThrow();
    expectCode(
      () => validateAcceptanceEvidence(acceptance, { ...intent, nonce: "2" }, bundle),
      ErrorCode.CREDIT_ACCEPTANCE_INVALID,
    );
  });

  it("derives repayment destination and exact principal plus fee", () => {
    expect(repaymentTerms(unsignedOffer({
      principalTinybar: 18_446_744_073_709_551_000n,
      feeTinybar: 615n,
    }))).toEqual({
      lenderAccountId: "0.0.20",
      amountTinybar: 18_446_744_073_709_551_615n,
    });
    expect(() => repaymentTerms(unsignedOffer({
      principalTinybar: 18_446_744_073_709_551_615n,
      feeTinybar: 1n,
    }))).toThrow("fit uint64");
  });
});
