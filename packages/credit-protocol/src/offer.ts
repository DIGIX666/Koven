import {
  CREDIT_SIGNATURE_DOMAINS,
  ErrorCode,
  type CreditAcceptance,
  type CreditOffer,
  type CreditRequest,
  type UnsignedCreditRequest,
} from "@koven/domain";
import type { PrivateKey, PublicKey } from "@koven/hedera";

import { canonicalHash, withoutSignature } from "./canonical.js";
import { signCanonicalPayload } from "./sign.js";
import { assertCredit, verifyCanonicalSignature } from "./verify.js";

export type UnsignedCreditOffer = Omit<CreditOffer, "signature">;

export interface SignedCreditAcceptance {
  acceptance: CreditAcceptance;
  signature: string;
}

const UINT64_MAX = (1n << 64n) - 1n;

export const computeTermsHash = (
  terms: Pick<CreditOffer, "requestId" | "lenderAccountId" | "principalTinybar" | "feeTinybar" | "termSeconds" | "expiresAt">,
): string => canonicalHash({
  requestId: terms.requestId,
  lenderAccountId: terms.lenderAccountId,
  principalTinybar: terms.principalTinybar,
  feeTinybar: terms.feeTinybar,
  termSeconds: terms.termSeconds,
  expiresAt: terms.expiresAt,
});

export function signCreditRequest(
  request: UnsignedCreditRequest,
  privateKey: PrivateKey,
): CreditRequest {
  return {
    ...request,
    signature: signCanonicalPayload(privateKey, CREDIT_SIGNATURE_DOMAINS.request, request),
  };
}

export function verifyCreditRequest(request: CreditRequest, publicKey: PublicKey): void {
  assertCredit(
    verifyCanonicalSignature(
      publicKey,
      CREDIT_SIGNATURE_DOMAINS.request,
      withoutSignature(request),
      request.signature,
    ),
    ErrorCode.CREDIT_REQUEST_SIGNATURE_INVALID,
    "Credit request signature is invalid",
  );
}

export function signCreditOffer(
  offer: UnsignedCreditOffer,
  privateKey: PrivateKey,
): CreditOffer {
  assertCredit(
    offer.principalTinybar >= 0n
      && offer.feeTinybar >= 0n
      && offer.principalTinybar + offer.feeTinybar <= UINT64_MAX,
    ErrorCode.REQUEST_INVALID,
    "Credit offer repayment amount exceeds uint64",
  );
  return {
    ...offer,
    signature: signCanonicalPayload(privateKey, CREDIT_SIGNATURE_DOMAINS.offer, offer),
  };
}

/** Validates signed offer inputs in the frozen protocol order. */
export function validateCreditOffer(
  offer: CreditOffer,
  request: CreditRequest,
  lenderPublicKey: PublicKey,
  now: string,
): void {
  assertCredit(
    verifyCanonicalSignature(
      lenderPublicKey,
      CREDIT_SIGNATURE_DOMAINS.offer,
      withoutSignature(offer),
      offer.signature,
    ),
    ErrorCode.OFFER_SIGNATURE_INVALID,
    "Credit offer signature is invalid",
  );
  assertCredit(
    offer.requestId === request.id,
    ErrorCode.REQUEST_INVALID,
    "Credit offer belongs to another request",
  );
  assertCredit(
    Date.parse(offer.expiresAt) > Date.parse(now),
    ErrorCode.OFFER_EXPIRED,
    "Credit offer has expired",
  );
  assertCredit(
    offer.principalTinybar >= request.principalTinybar,
    ErrorCode.REQUEST_INVALID,
    "Credit offer principal does not cover the request",
  );
  assertCredit(
    offer.termsHash === computeTermsHash(offer),
    ErrorCode.REQUEST_INVALID,
    "Credit offer terms hash is invalid",
  );
  assertCredit(
    offer.termSeconds === request.requestedTermSeconds,
    ErrorCode.REQUEST_INVALID,
    "Credit offer term does not match the request",
  );
  assertCredit(
    offer.principalTinybar >= 0n
      && offer.feeTinybar >= 0n
      && offer.principalTinybar + offer.feeTinybar <= UINT64_MAX,
    ErrorCode.REQUEST_INVALID,
    "Credit offer repayment amount exceeds uint64",
  );
}

export function signCreditAcceptance(
  acceptance: CreditAcceptance,
  privateKey: PrivateKey,
): SignedCreditAcceptance {
  assertCredit(
    (acceptance.paymentIntentHash === undefined)
      === (acceptance.paymentProofBundleHash === undefined),
    ErrorCode.CREDIT_ACCEPTANCE_INVALID,
    "Payment intent and proof hashes must be present together",
  );
  return {
    acceptance,
    signature: signCanonicalPayload(
      privateKey,
      CREDIT_SIGNATURE_DOMAINS.acceptance,
      acceptance,
    ),
  };
}

export function validateCreditAcceptance(
  signed: SignedCreditAcceptance,
  request: CreditRequest,
  offer: CreditOffer,
  borrowerPublicKey: PublicKey,
  now: string,
): void {
  assertCredit(
    verifyCanonicalSignature(
      borrowerPublicKey,
      CREDIT_SIGNATURE_DOMAINS.acceptance,
      signed.acceptance,
      signed.signature,
    ),
    ErrorCode.CREDIT_ACCEPTANCE_INVALID,
    "Credit acceptance signature is invalid",
  );
  const acceptance = signed.acceptance;
  assertCredit(
    (acceptance.paymentIntentHash === undefined)
      === (acceptance.paymentProofBundleHash === undefined),
    ErrorCode.CREDIT_ACCEPTANCE_INVALID,
    "Payment intent and proof hashes must be present together",
  );
  assertCredit(
    acceptance.requestId === request.id
      && acceptance.missionId === request.missionId
      && acceptance.borrowerAccountId === request.borrowerAccountId
      && acceptance.lenderAccountId === offer.lenderAccountId
      && acceptance.offerId === offer.id
      && acceptance.termsHash === offer.termsHash
      && acceptance.expiresAt === offer.expiresAt,
    ErrorCode.CREDIT_ACCEPTANCE_INVALID,
    "Credit acceptance is not bound to the signed request and offer",
  );
  assertCredit(
    Date.parse(acceptance.expiresAt) > Date.parse(now),
    ErrorCode.OFFER_EXPIRED,
    "Credit acceptance has expired",
  );
}

/** Checks optional M3 wire evidence against the hashes covered by the acceptance signature. */
export function validateAcceptanceEvidence(
  acceptance: CreditAcceptance,
  paymentIntent?: unknown,
  paymentProofBundle?: unknown,
): void {
  const hasEvidence = paymentIntent !== undefined && paymentProofBundle !== undefined;
  const hasHashes = acceptance.paymentIntentHash !== undefined
    && acceptance.paymentProofBundleHash !== undefined;
  assertCredit(
    hasEvidence === hasHashes
      && (paymentIntent === undefined) === (paymentProofBundle === undefined),
    ErrorCode.CREDIT_ACCEPTANCE_INVALID,
    "Payment evidence and signed hashes must be present together",
  );
  if (!hasEvidence || !hasHashes) return;
  assertCredit(
    canonicalHash(paymentIntent) === acceptance.paymentIntentHash
      && canonicalHash(paymentProofBundle) === acceptance.paymentProofBundleHash,
    ErrorCode.CREDIT_ACCEPTANCE_INVALID,
    "Payment evidence does not match the signed acceptance hashes",
  );
}
