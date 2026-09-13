import { CREDIT_SIGNATURE_DOMAINS, ErrorCode, type CreditAcceptance, type UnsignedCreditRequest } from "@koven/domain";
import { PublicKey, type PrivateKey } from "@koven/hedera";
import {
  LoanRegistrationRequestSchema,
  LoanRegistrationResponseSchema,
  SignatureResponseSchema,
  SignCreditAcceptanceSchema,
  SignCreditAcceptanceZkSchema,
  SignCreditRequestSchema,
  SignedAcceptanceSchema,
  UINT64_MAX,
  type HttpRequest,
  type HttpResponse,
} from "@koven/schemas";
import { resourceHashHex } from "@koven/x402";

import { canonicalHash, canonicalJson, signDomain, verifyDomain, withoutSignature } from "./canonical.js";
import { fail } from "./errors.js";
import type { TransferConfirmer } from "./ledger.js";
import type { ProofMode, ProofPolicy } from "./proof.js";
import type { MissionPolicy, SignerStore, WireOffer } from "./store.js";

export interface CreditServiceOptions {
  readonly store: SignerStore;
  readonly accountId: string;
  readonly privateKey: PrivateKey;
  readonly lenderPublicKeys: Readonly<Record<string, string>>;
  readonly confirmer: TransferConfirmer;
  readonly now?: () => string;
  /** M3: acceptance requires the normalized intent and its proof, checked against trusted policy. */
  readonly proofMode?: ProofMode;
  readonly proofPolicy?: ProofPolicy;
}

/** `purposeHash` is SHA-256 of canonical `{ missionId, targetSha256 }` from the stored mission. */
export const purposeHashFor = (missionId: string, targetSha256: string): string => (
  canonicalHash({ missionId, targetSha256 })
);

export const termsHashFor = (offer: Pick<WireOffer, "requestId" | "lenderAccountId" | "principalTinybar" | "feeTinybar" | "termSeconds" | "expiresAt">): string => (
  canonicalHash({
    requestId: offer.requestId,
    lenderAccountId: offer.lenderAccountId,
    principalTinybar: offer.principalTinybar,
    feeTinybar: offer.feeTinybar,
    termSeconds: offer.termSeconds,
    expiresAt: offer.expiresAt,
  })
);

/**
 * The typed credit commands. They sign canonical, domain-separated payloads
 * the signer constructs itself from trusted mission policy and pinned lender
 * keys; nothing here signs arbitrary bytes.
 */
export class CreditService {
  private readonly now: () => string;
  private readonly proofMode: ProofMode;

  constructor(private readonly options: CreditServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.proofMode = options.proofMode ?? "deterministic";
    if (this.proofMode === "zk" && options.proofPolicy === undefined) {
      throw new Error("zk credit acceptance requires a pinned verification key");
    }
  }

  /** M3: the signed intent must describe a payment the trusted mission policy allows. */
  private async assertIntent(
    policy: MissionPolicy,
    intent: HttpRequest<"signCreditAcceptance">["paymentIntent"] & object,
    bundle: HttpRequest<"signCreditAcceptance">["paymentProofBundle"] & object,
  ): Promise<void> {
    const challenge = { ...intent, amountTinybar: BigInt(intent.amountTinybar) };
    if (
      intent.missionId !== policy.missionId
      || intent.recipientAccountId !== policy.provider.accountId
      || challenge.amountTinybar > BigInt(policy.spendingCapTinybar)
      || intent.resourceHash !== resourceHashHex(`${policy.provider.endpoint}/scan`, policy.missionId, policy.targetSha256)
    ) fail(ErrorCode.MISSION_POLICY_MISMATCH, "Payment intent does not match the trusted mission policy");
    await this.options.proofPolicy!.assertProof(bundle, policy, challenge);
  }

  signCreditRequest(input: HttpRequest<"signCreditRequest">): HttpResponse<"signCreditRequest"> {
    const { request } = SignCreditRequestSchema.parse(input);
    const policy = this.options.store.getMissionPolicy(request.missionId);
    if (policy === undefined) fail(ErrorCode.MISSION_POLICY_MISSING, "Mission policy is not provisioned");
    if (
      request.borrowerAccountId !== this.options.accountId
      || policy.borrowerAccountId !== this.options.accountId
      || request.purposeHash !== purposeHashFor(policy.missionId, policy.targetSha256)
    ) fail(ErrorCode.MISSION_POLICY_MISMATCH, "Credit request is not bound to this borrower's mission policy");
    const principal = BigInt(request.principalTinybar);
    if (principal === 0n || principal > BigInt(policy.spendingCapTinybar)) {
      fail(ErrorCode.REQUEST_INVALID, "Principal must be nonzero and within the mission spending cap");
    }
    if (request.requestedTermSeconds <= 0) fail(ErrorCode.REQUEST_INVALID, "Requested term must be positive");

    const unsigned: UnsignedCreditRequest = { ...request, principalTinybar: principal };
    const signature = signDomain(this.options.privateKey, CREDIT_SIGNATURE_DOMAINS.request, request);
    const stored = this.options.store.saveCreditRequest(unsigned, signature, this.now());
    return SignatureResponseSchema.parse({ signature: stored.signature });
  }

  private lenderKey(lenderAccountId: string): PublicKey {
    const encoded = this.options.lenderPublicKeys[lenderAccountId];
    if (encoded === undefined) fail(ErrorCode.OFFER_SIGNATURE_INVALID, "Lender key is not pinned in configuration");
    return PublicKey.fromStringECDSA(encoded);
  }

  /** Offer checks in the frozen order: signature, request ID, expiry, principal coverage, terms hash, term. */
  private validateOffer(offer: WireOffer, request: UnsignedCreditRequest): void {
    if (!verifyDomain(this.lenderKey(offer.lenderAccountId), CREDIT_SIGNATURE_DOMAINS.offer, withoutSignature(offer), offer.signature)) {
      fail(ErrorCode.OFFER_SIGNATURE_INVALID, "Credit offer signature is invalid");
    }
    if (offer.requestId !== request.id) fail(ErrorCode.REQUEST_INVALID, "Credit offer belongs to another request");
    if (Date.parse(offer.expiresAt) <= Date.parse(this.now())) fail(ErrorCode.OFFER_EXPIRED, "Credit offer has expired");
    if (BigInt(offer.principalTinybar) < request.principalTinybar) {
      fail(ErrorCode.REQUEST_INVALID, "Credit offer principal does not cover the request");
    }
    if (offer.termsHash !== termsHashFor(offer)) fail(ErrorCode.REQUEST_INVALID, "Credit offer terms hash is invalid");
    if (offer.termSeconds !== request.requestedTermSeconds) fail(ErrorCode.REQUEST_INVALID, "Credit offer term does not match the request");
    if (BigInt(offer.principalTinybar) + BigInt(offer.feeTinybar) > UINT64_MAX) {
      fail(ErrorCode.REQUEST_INVALID, "Credit offer repayment amount exceeds uint64");
    }
  }

  async signCreditAcceptance(input: HttpRequest<"signCreditAcceptance">): Promise<HttpResponse<"signCreditAcceptance">> {
    const { offer, paymentIntent, paymentProofBundle } = this.proofMode === "zk"
      ? SignCreditAcceptanceZkSchema.parse(input)
      : SignCreditAcceptanceSchema.parse(input);
    const stored = this.options.store.getCreditRequest(offer.requestId);
    if (stored === undefined) fail(ErrorCode.REQUEST_INVALID, "Credit offer references an unknown request");
    const policy = this.options.store.getMissionPolicy(stored.request.missionId);
    if (policy === undefined) fail(ErrorCode.MISSION_POLICY_MISSING, "Mission policy is not provisioned");
    this.validateOffer(offer, stored.request);
    if (BigInt(offer.principalTinybar) > BigInt(policy.spendingCapTinybar)) {
      fail(ErrorCode.MISSION_POLICY_MISMATCH, "Credit offer principal exceeds the mission spending cap");
    }
    // M2 binds optional evidence by hash only; M3 requires it and verifies it against trusted policy.
    if (this.proofMode === "zk" && paymentIntent !== undefined && paymentProofBundle !== undefined) {
      await this.assertIntent(policy, paymentIntent, paymentProofBundle);
    }

    const acceptance: CreditAcceptance = {
      requestId: stored.request.id,
      missionId: stored.request.missionId,
      borrowerAccountId: stored.request.borrowerAccountId,
      lenderAccountId: offer.lenderAccountId,
      offerId: offer.id,
      termsHash: offer.termsHash,
      expiresAt: offer.expiresAt,
      ...(paymentIntent !== undefined && paymentProofBundle !== undefined
        ? { paymentIntentHash: canonicalHash(paymentIntent), paymentProofBundleHash: canonicalHash(paymentProofBundle) }
        : {}),
    };
    const signature = signDomain(this.options.privateKey, CREDIT_SIGNATURE_DOMAINS.acceptance, acceptance);
    const saved = this.options.store.saveAcceptance(offer, acceptance, signature, this.now());
    return SignedAcceptanceSchema.parse({ acceptance: saved.acceptance, signature: saved.signature });
  }

  /**
   * Lender-authenticated registration of a funded loan. Every document is
   * checked against what this signer stored and signed, the lender identity
   * comes from the credential, and funding is confirmed on the ledger before
   * the loan becomes repayable.
   */
  async registerLoan(
    lenderAccountId: string,
    input: HttpRequest<"registerLoan">,
  ): Promise<HttpResponse<"registerLoan">> {
    const body = LoanRegistrationRequestSchema.parse(input);
    if (body.offer.lenderAccountId !== lenderAccountId || body.acceptance.lenderAccountId !== lenderAccountId) {
      fail(ErrorCode.AUTH_INVALID, "Loan documents do not belong to the authenticated lender");
    }
    const storedRequest = this.options.store.getCreditRequest(body.request.id);
    const storedAcceptance = this.options.store.getAcceptance(body.acceptance.missionId);
    if (
      storedRequest === undefined
      || canonicalJson(withoutSignature(body.request)) !== canonicalJson(storedRequest.request)
      || body.request.signature !== storedRequest.signature
    ) fail(ErrorCode.CREDIT_ACCEPTANCE_INVALID, "Credit request does not match the signer's record");
    if (
      storedAcceptance === undefined
      || canonicalJson(body.acceptance) !== canonicalJson(storedAcceptance.acceptance)
      || body.signatures.acceptance !== storedAcceptance.signature
      || canonicalJson(body.offer) !== canonicalJson(storedAcceptance.offer)
    ) fail(ErrorCode.CREDIT_ACCEPTANCE_INVALID, "Acceptance or offer does not match the signer's record");
    if (!verifyDomain(this.lenderKey(lenderAccountId), CREDIT_SIGNATURE_DOMAINS.offer, withoutSignature(body.offer), body.offer.signature)) {
      fail(ErrorCode.OFFER_SIGNATURE_INVALID, "Credit offer signature is invalid");
    }
    if (body.acceptance.requestId !== body.request.id || body.offer.requestId !== body.request.id || body.acceptance.offerId !== body.offer.id) {
      fail(ErrorCode.CREDIT_ACCEPTANCE_INVALID, "Loan documents do not reference each other");
    }

    const principal = BigInt(body.offer.principalTinybar);
    await this.options.confirmer.confirm({
      transactionId: body.fundingTxId,
      payerAccountId: lenderAccountId,
      recipientAccountId: this.options.accountId,
      amountTinybar: principal,
    });

    const loan = this.options.store.registerFundedLoan({
      id: body.loanId,
      offerId: body.offer.id,
      missionId: body.acceptance.missionId,
      lenderAccountId,
      principalTinybar: principal,
      feeTinybar: BigInt(body.offer.feeTinybar),
      state: "funded",
      fundingTxId: body.fundingTxId,
    });
    return LoanRegistrationResponseSchema.parse({ loanId: loan.id, state: "funded" });
  }
}
