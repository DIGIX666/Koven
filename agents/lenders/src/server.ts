import { timingSafeEqual } from "node:crypto";

import express, { type Application, type ErrorRequestHandler, type RequestHandler } from "express";
import {
  canonicalHash,
  computeTermsHash,
  CreditProtocolError,
  signCreditOffer,
  validateAcceptanceEvidence,
  validateCreditAcceptance,
  validateCreditOffer,
  verifyCreditRequest,
  type SignedCreditAcceptance,
  type UnsignedCreditOffer,
} from "@koven/credit-protocol";
import { ErrorCode, type CreditAcceptance, type CreditRequest } from "@koven/domain";
import type { PrivateKey, PublicKey } from "@koven/hedera";
import {
  CreditAcceptRequestSchema,
  CreditAcceptResponseSchema,
  CreditOfferSchema,
  CreditRequestSchema,
  ErrorResponseSchema,
  MAX_HTTP_BODY_BYTES,
  MissionPolicyRequestSchema,
  MissionPolicyResponseSchema,
  ServiceAuthHeadersSchema,
} from "@koven/schemas";
import { ZodError } from "zod";

import type { FundingService } from "./fund.js";
import type { LenderPolicy } from "./policy.js";
import { LenderStore } from "./store.js";

export interface LenderAppOptions {
  store: LenderStore;
  policy: LenderPolicy;
  fundingService: FundingService;
  lenderAccountId: string;
  lenderPrivateKey: PrivateKey;
  operatorCredential: string;
  borrowerPublicKey(accountId: string): PublicKey | undefined;
  borrowerReputation(accountId: string): number;
  now?: () => string;
  offerValiditySeconds?: number;
}

const asyncRoute = (handler: RequestHandler): RequestHandler => (request, response, next) => {
  Promise.resolve(handler(request, response, next)).catch(next);
};

const asCreditRequest = (wire: ReturnType<typeof CreditRequestSchema.parse>): CreditRequest => ({
  ...wire,
  principalTinybar: BigInt(wire.principalTinybar),
});

const offerResponse = (offer: ReturnType<LenderStore["saveOffer"]>) => CreditOfferSchema.parse({
  ...offer,
  principalTinybar: offer.principalTinybar.toString(10),
  feeTinybar: offer.feeTinybar.toString(10),
});

const asCreditAcceptance = (
  wire: ReturnType<typeof CreditAcceptRequestSchema.parse>["acceptance"],
): CreditAcceptance => ({
  requestId: wire.requestId,
  missionId: wire.missionId,
  borrowerAccountId: wire.borrowerAccountId,
  lenderAccountId: wire.lenderAccountId,
  offerId: wire.offerId,
  termsHash: wire.termsHash,
  expiresAt: wire.expiresAt,
  ...(wire.paymentIntentHash === undefined ? {} : { paymentIntentHash: wire.paymentIntentHash }),
  ...(wire.paymentProofBundleHash === undefined
    ? {}
    : { paymentProofBundleHash: wire.paymentProofBundleHash }),
});

const credentialsMatch = (actual: string, expected: string): boolean => {
  const left = Buffer.from(actual);
  const right = Buffer.from(`Bearer ${expected}`);
  return left.length === right.length && timingSafeEqual(left, right);
};

const requireOperator = (authorization: string | undefined, expected: string): void => {
  const parsed = ServiceAuthHeadersSchema.safeParse({ authorization });
  if (!parsed.success || !credentialsMatch(parsed.data.authorization, expected)) {
    throw new CreditProtocolError(ErrorCode.AUTH_INVALID, "Operator authentication failed");
  }
};

const statusFor = (code: string): number => {
  switch (code) {
    case ErrorCode.AUTH_INVALID:
    case ErrorCode.CREDIT_REQUEST_SIGNATURE_INVALID:
    case ErrorCode.CREDIT_ACCEPTANCE_INVALID:
    case ErrorCode.OFFER_SIGNATURE_INVALID:
      return 401;
    case ErrorCode.MISSION_POLICY_MISSING:
    case ErrorCode.MISSION_POLICY_MISMATCH:
      return 403;
    case ErrorCode.OFFER_EXPIRED:
    case ErrorCode.CREDIT_ACCEPTANCE_CONFLICT:
    case ErrorCode.IDEMPOTENCY_CONFLICT:
    case ErrorCode.MISSION_POLICY_CONFLICT:
    case ErrorCode.FUNDING_MISMATCH:
      return 409;
    case ErrorCode.SETTLEMENT_UNCONFIRMED:
      return 503;
    case ErrorCode.REQUEST_INVALID:
      return 400;
    default:
      return 500;
  }
};

const isBodyTooLarge = (error: unknown): boolean => error instanceof Error
  && "type" in error
  && error.type === "entity.too.large";

/** Creates the deterministic lender HTTP boundary over injected network adapters. */
export function createLenderApp(options: LenderAppOptions): Application {
  const app = express();
  const now = options.now ?? (() => new Date().toISOString());
  const offerValiditySeconds = options.offerValiditySeconds ?? 300;
  app.disable("x-powered-by");
  app.use(express.json({ limit: MAX_HTTP_BODY_BYTES }));

  app.post("/internal/missions/register", asyncRoute(async (request, response) => {
    requireOperator(request.get("authorization"), options.operatorCredential);
    const policy = MissionPolicyRequestSchema.parse(request.body);
    options.store.registerMissionPolicy(policy, now());
    response.json(MissionPolicyResponseSchema.parse({
      missionId: policy.missionId,
      status: "registered",
    }));
  }));

  app.post("/credit/quote", asyncRoute(async (request, response) => {
    const creditRequest = asCreditRequest(CreditRequestSchema.parse(request.body));
    const borrowerKey = options.borrowerPublicKey(creditRequest.borrowerAccountId);
    if (borrowerKey === undefined) {
      throw new CreditProtocolError(
        ErrorCode.CREDIT_REQUEST_SIGNATURE_INVALID,
        "Borrower public key is not configured",
      );
    }
    verifyCreditRequest(creditRequest, borrowerKey);

    const missionPolicy = options.store.getMissionPolicy(creditRequest.missionId);
    if (missionPolicy === undefined) {
      throw new CreditProtocolError(ErrorCode.MISSION_POLICY_MISSING, "Mission policy is missing");
    }
    const expectedPurposeHash = canonicalHash({
      missionId: missionPolicy.missionId,
      targetSha256: missionPolicy.targetSha256,
    });
    if (missionPolicy.borrowerAccountId !== creditRequest.borrowerAccountId
      || expectedPurposeHash !== creditRequest.purposeHash
      || creditRequest.principalTinybar > BigInt(missionPolicy.spendingCapTinybar)) {
      throw new CreditProtocolError(
        ErrorCode.MISSION_POLICY_MISMATCH,
        "Credit request does not match the registered mission policy",
      );
    }

    const decision = options.policy.evaluate(
      creditRequest,
      options.borrowerReputation(creditRequest.borrowerAccountId),
    );
    if (decision === undefined) {
      response.status(204).end();
      return;
    }
    const expiresAt = new Date(Date.parse(now()) + offerValiditySeconds * 1_000).toISOString();
    const terms = {
      id: `offer-${canonicalHash(creditRequest).slice(0, 32)}`,
      requestId: creditRequest.id,
      lenderAccountId: options.lenderAccountId,
      principalTinybar: creditRequest.principalTinybar,
      feeTinybar: decision.feeTinybar,
      termSeconds: decision.termSeconds,
      expiresAt,
    };
    const unsigned: UnsignedCreditOffer = { ...terms, termsHash: computeTermsHash(terms) };
    const offer = options.store.saveOffer(
      creditRequest,
      signCreditOffer(unsigned, options.lenderPrivateKey),
      now(),
    );
    response.json(offerResponse(offer));
  }));

  app.post("/credit/accept", asyncRoute(async (request, response) => {
    const accepted = CreditAcceptRequestSchema.parse(request.body);
    const stored = options.store.getOffer(accepted.acceptance.offerId);
    if (stored === undefined) {
      throw new CreditProtocolError(ErrorCode.CREDIT_ACCEPTANCE_INVALID, "Credit offer is unknown");
    }
    const borrowerKey = options.borrowerPublicKey(stored.request.borrowerAccountId);
    if (borrowerKey === undefined) {
      throw new CreditProtocolError(
        ErrorCode.CREDIT_ACCEPTANCE_INVALID,
        "Borrower public key is not configured",
      );
    }
    const missionPolicy = options.store.getMissionPolicy(stored.request.missionId);
    if (missionPolicy === undefined) {
      throw new CreditProtocolError(ErrorCode.MISSION_POLICY_MISSING, "Mission policy is missing");
    }
    const expectedPurposeHash = canonicalHash({
      missionId: missionPolicy.missionId,
      targetSha256: missionPolicy.targetSha256,
    });
    if (missionPolicy.borrowerAccountId !== stored.request.borrowerAccountId
      || expectedPurposeHash !== stored.request.purposeHash
      || stored.offer.principalTinybar > BigInt(missionPolicy.spendingCapTinybar)) {
      throw new CreditProtocolError(
        ErrorCode.MISSION_POLICY_MISMATCH,
        "Stored offer does not match the registered mission policy",
      );
    }
    validateCreditOffer(
      stored.offer,
      stored.request,
      options.lenderPrivateKey.publicKey,
      now(),
    );
    const signed: SignedCreditAcceptance = {
      acceptance: asCreditAcceptance(accepted.acceptance),
      signature: accepted.signature,
    };
    validateCreditAcceptance(signed, stored.request, stored.offer, borrowerKey, now());
    validateAcceptanceEvidence(
      signed.acceptance,
      accepted.paymentIntent,
      accepted.paymentProofBundle,
    );
    const result = await options.fundingService.accept(stored.request, stored.offer, signed);
    response.json(CreditAcceptResponseSchema.parse(result));
  }));

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (isBodyTooLarge(error)) {
      response.status(413).json(ErrorResponseSchema.parse({
        code: ErrorCode.SOURCE_TOO_LARGE,
        detail: "Request body exceeds the transport limit",
      }));
      return;
    }
    const code = error instanceof CreditProtocolError
      ? error.code
      : error instanceof ZodError ? ErrorCode.REQUEST_INVALID : ErrorCode.INTERNAL_ERROR;
    const status = error instanceof ZodError ? 400 : statusFor(code);
    const detail = error instanceof ZodError
      ? error.issues.map(issue => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ")
      : error instanceof CreditProtocolError ? error.message : "Internal server error";
    response.status(status).json(ErrorResponseSchema.parse({ code, detail }));
  };
  app.use(errorHandler);
  return app;
}
