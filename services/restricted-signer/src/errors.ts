import { ErrorCode } from "@koven/domain";

type Code = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Recommended HTTP mapping frozen in docs/protocol.md ("Error codes"). */
const STATUS: Partial<Record<Code, number>> = {
  [ErrorCode.REQUEST_INVALID]: 400,
  [ErrorCode.SOURCE_HASH_MISMATCH]: 400,
  [ErrorCode.REPORT_SCHEMA_INVALID]: 400,
  [ErrorCode.REPORT_BINDING_MISMATCH]: 400,
  [ErrorCode.CHALLENGE_BINDING_MISMATCH]: 400,
  [ErrorCode.AUTH_INVALID]: 401,
  [ErrorCode.CALLBACK_AUTH_INVALID]: 401,
  [ErrorCode.CREDIT_REQUEST_SIGNATURE_INVALID]: 401,
  [ErrorCode.OFFER_SIGNATURE_INVALID]: 401,
  [ErrorCode.CREDIT_ACCEPTANCE_INVALID]: 401,
  [ErrorCode.PAYMENT_AUTHORIZATION_INVALID]: 401,
  [ErrorCode.PROOF_INVALID]: 403,
  [ErrorCode.PROOF_VKEY_MISMATCH]: 403,
  [ErrorCode.CIRCUIT_ID_MISMATCH]: 403,
  [ErrorCode.RECIPIENT_NOT_APPROVED]: 403,
  [ErrorCode.CAP_EXCEEDED]: 403,
  [ErrorCode.CUMULATIVE_BUDGET_EXCEEDED]: 403,
  [ErrorCode.PAYMENT_AUTHORIZATION_MISMATCH]: 403,
  [ErrorCode.MISSION_POLICY_MISSING]: 403,
  [ErrorCode.MISSION_POLICY_MISMATCH]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.NONCE_ALREADY_USED]: 409,
  [ErrorCode.OFFER_EXPIRED]: 409,
  [ErrorCode.ILLEGAL_STATE_TRANSITION]: 409,
  [ErrorCode.CREDIT_ACCEPTANCE_CONFLICT]: 409,
  [ErrorCode.LOAN_REGISTRATION_CONFLICT]: 409,
  [ErrorCode.LOAN_NOT_FUNDED]: 409,
  [ErrorCode.MISSION_NOT_REPAYABLE]: 409,
  [ErrorCode.FUNDING_MISMATCH]: 409,
  [ErrorCode.IDEMPOTENCY_CONFLICT]: 409,
  [ErrorCode.MISSION_POLICY_CONFLICT]: 409,
  [ErrorCode.SOURCE_TOO_LARGE]: 413,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.SETTLEMENT_UNCONFIRMED]: 503,
};

export class SignerError extends Error {
  readonly status: number;

  constructor(readonly code: Code, detail: string) {
    super(detail);
    this.name = "SignerError";
    this.status = STATUS[code] ?? 500;
  }
}

export function fail(code: Code, detail: string): never {
  throw new SignerError(code, detail);
}
