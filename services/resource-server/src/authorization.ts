import { createHash } from "node:crypto";

import type { PaymentPayload } from "@x402/core/types";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { validatePaymentPayload } from "@x402/core/schemas";
import {
  getNetForAccount,
  getPositiveReceivers,
  inspectHederaTransaction,
} from "@x402/hedera";
import { ErrorCode } from "@koven/domain";
import { PublicKey } from "@koven/hedera";
import {
  Base64,
  PaidScanRequestSchema,
  ScanPaymentAuthorizationSchema,
} from "@koven/schemas";

import { canonicalJson, sha256Hex } from "./report.js";
import { parseBoundPaidScanRequestBase } from "./request.js";

const AUTHORIZATION_DOMAIN = "koven:scan-payment-authorization:v1";

type WireAuthorization = ReturnType<typeof ScanPaymentAuthorizationSchema.parse>;
export type PaidScanRequest = ReturnType<typeof PaidScanRequestSchema.parse>;

export type PaymentAuthorizationErrorCode =
  | typeof ErrorCode.PAYMENT_AUTHORIZATION_INVALID
  | typeof ErrorCode.PAYMENT_AUTHORIZATION_MISMATCH;

export class PaymentAuthorizationError extends Error {
  constructor(
    readonly code: PaymentAuthorizationErrorCode,
    readonly status: 401 | 403,
    detail: string,
  ) {
    super(detail);
    this.name = "PaymentAuthorizationError";
  }
}

export interface PaymentAuthorizationPolicy {
  readonly providerAccountId: string;
  readonly scanUrl: string;
  readonly amountTinybar: string;
  readonly network: "hedera:testnet";
  readonly asset: "0.0.0";
  readonly feePayerAccountId: string;
  readonly signerPublicKeys: Readonly<Record<string, string>>;
}

export interface ValidatedPaymentAttempt {
  readonly request: PaidScanRequest;
  readonly authorization: WireAuthorization;
  readonly paymentPayload: PaymentPayload;
  readonly transactionBase64: string;
  readonly fingerprint: string;
}

export function authorizationSigningPayload(authorization: WireAuthorization): string {
  const { signature: _signature, ...unsigned } = authorization;
  return `${AUTHORIZATION_DOMAIN}\n${canonicalJson(unsigned)}`;
}

function invalid(detail: string): never {
  throw new PaymentAuthorizationError(ErrorCode.PAYMENT_AUTHORIZATION_INVALID, 401, detail);
}

function mismatch(detail: string): never {
  throw new PaymentAuthorizationError(ErrorCode.PAYMENT_AUTHORIZATION_MISMATCH, 403, detail);
}

function verifyAuthorizationSignature(
  authorization: WireAuthorization,
  signerPublicKeys: Readonly<Record<string, string>>,
): void {
  const encodedKey = signerPublicKeys[authorization.borrowerAccountId];
  if (!encodedKey) invalid("No trusted signer key is configured for the borrower");

  try {
    const key = PublicKey.fromStringECDSA(encodedKey);
    const valid = key.verify(
      Buffer.from(authorizationSigningPayload(authorization), "utf8"),
      Buffer.from(authorization.signature, "hex"),
    );
    if (!valid) invalid("Payment authorization signature is invalid");
  } catch (error) {
    if (error instanceof PaymentAuthorizationError) throw error;
    invalid("Payment authorization signature is invalid");
  }
}

function transactionFromPayload(payload: PaymentPayload): string {
  const transaction = payload.payload.transaction;
  if (typeof transaction !== "string" || !Base64.safeParse(transaction).success) {
    invalid("Payment payload does not contain a valid Hedera transaction");
  }
  return transaction;
}

function assertPolicyBinding(
  request: PaidScanRequest,
  authorization: WireAuthorization,
  payload: PaymentPayload,
  policy: PaymentAuthorizationPolicy,
): void {
  if (
    request.missionId !== authorization.missionId
    || request.targetSha256 !== authorization.targetSha256
    || authorization.providerAccountId !== policy.providerAccountId
    || authorization.scanUrl !== policy.scanUrl
    || authorization.amountTinybar !== policy.amountTinybar
    || authorization.network !== policy.network
    || authorization.asset !== policy.asset
  ) mismatch("Payment authorization does not match this scan");

  const accepted = payload.accepted;
  if (
    payload.x402Version !== 2
    || accepted.scheme !== "exact"
    || accepted.network !== policy.network
    || accepted.asset !== policy.asset
    || accepted.amount !== policy.amountTinybar
    || accepted.payTo !== policy.providerAccountId
    || accepted.maxTimeoutSeconds !== 180
    || accepted.extra.feePayer !== policy.feePayerAccountId
    || (payload.resource !== undefined && payload.resource.url !== policy.scanUrl)
  ) mismatch("x402 payment requirements do not match this provider");
}

function assertTransactionBinding(
  transactionBase64: string,
  authorization: WireAuthorization,
  policy: PaymentAuthorizationPolicy,
): void {
  const bytes = Buffer.from(transactionBase64, "base64");
  if (bytes.toString("base64") !== transactionBase64) invalid("Hedera transaction encoding is not canonical base64");
  if (createHash("sha256").update(bytes).digest("hex") !== authorization.transactionSha256) {
    mismatch("Hedera transaction bytes do not match the authorization");
  }

  let transaction: ReturnType<typeof inspectHederaTransaction>;
  try {
    transaction = inspectHederaTransaction(transactionBase64);
  } catch {
    invalid("Hedera transaction cannot be decoded");
  }

  if (
    policy.feePayerAccountId === authorization.borrowerAccountId
    || policy.feePayerAccountId === authorization.providerAccountId
    || transaction.hasNonTransferOperations
    || Object.keys(transaction.tokenTransfers).length !== 0
    || transaction.hbarTransfers.length !== 2
    || transaction.transactionId !== authorization.transactionId
    || transaction.transactionIdAccountId !== policy.feePayerAccountId
    || getNetForAccount(transaction.hbarTransfers, authorization.borrowerAccountId) !== -BigInt(authorization.amountTinybar)
    || getNetForAccount(transaction.hbarTransfers, authorization.providerAccountId) !== BigInt(authorization.amountTinybar)
    || getPositiveReceivers(transaction.hbarTransfers).some(accountId => accountId !== authorization.providerAccountId)
  ) mismatch("Hedera transaction does not match the authorized transfer");
}

/** Validates all provider-owned checks before x402 calls the facilitator. */
export function validatePaidPaymentAttempt(
  body: unknown,
  paymentSignatureHeader: string,
  policy: PaymentAuthorizationPolicy,
  now: Date = new Date(),
): ValidatedPaymentAttempt {
  parseBoundPaidScanRequestBase(body);

  const authorizationCandidate = typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>).paymentAuthorization
    : undefined;
  const parsedAuthorization = ScanPaymentAuthorizationSchema.safeParse(authorizationCandidate);
  if (!parsedAuthorization.success) invalid("Payment authorization is missing or malformed");
  const authorization = parsedAuthorization.data;

  verifyAuthorizationSignature(authorization, policy.signerPublicKeys);
  if (Date.parse(authorization.expiresAt) <= now.getTime()) invalid("Payment authorization has expired");

  const parsedRequest = PaidScanRequestSchema.safeParse(body);
  if (!parsedRequest.success) mismatch("Payment authorization does not match the submitted source");

  let paymentPayload: PaymentPayload;
  try {
    paymentPayload = validatePaymentPayload(decodePaymentSignatureHeader(paymentSignatureHeader)) as PaymentPayload;
  } catch {
    invalid("PAYMENT-SIGNATURE header is malformed");
  }

  assertPolicyBinding(parsedRequest.data, authorization, paymentPayload, policy);
  const transactionBase64 = transactionFromPayload(paymentPayload);
  assertTransactionBinding(transactionBase64, authorization, policy);

  return {
    request: parsedRequest.data,
    authorization,
    paymentPayload,
    transactionBase64,
    fingerprint: sha256Hex(canonicalJson({ request: parsedRequest.data, paymentPayload })),
  };
}
