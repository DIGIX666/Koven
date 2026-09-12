import { decodePaymentResponseHeader } from "@x402/core/http";
import { ErrorCode, type PaymentReceipt, type PaymentRequirements } from "@koven/domain";
import { AccountId, PaymentReceiptSchema, PaymentResponseHeadersSchema, TransactionId } from "@koven/schemas";

export class SettlementDecodeError extends Error {
  readonly code = ErrorCode.SETTLEMENT_UNCONFIRMED;

  constructor(readonly reason: string) {
    super(`x402 settlement rejected: ${reason}`);
    this.name = "SettlementDecodeError";
  }
}

function reject(reason: string): never {
  throw new SettlementDecodeError(reason);
}

export interface SettlementExpectation {
  readonly missionId: string;
  /** The requirements the payment was built for; recipient, asset and amount come from here. */
  readonly requirements: PaymentRequirements;
  /** Borrower account that signed the transfer. */
  readonly payer: string;
  /** RFC3339 UTC time the settlement header was observed. */
  readonly observedAt: string;
}

/**
 * Decodes a `PAYMENT-RESPONSE` header into a `PaymentReceipt` bound to the
 * payment the consumer actually made. The SDK envelope only carries success,
 * transaction, network and payer, so recipient, asset and amount are taken
 * from the accepted requirements and every overlapping field must agree.
 * This receipt is client-side evidence only; completion is confirmed by the
 * provider callback and the independent ledger checks downstream.
 */
export function decodeSettlement(headerValue: string, expected: SettlementExpectation): PaymentReceipt {
  if (!PaymentResponseHeadersSchema.safeParse({ "payment-response": headerValue }).success) {
    reject("header is not base64");
  }
  let settlement: ReturnType<typeof decodePaymentResponseHeader>;
  try {
    settlement = decodePaymentResponseHeader(headerValue);
  } catch {
    reject("header is not a settlement envelope");
  }
  if (settlement.success !== true) reject(settlement.errorReason ?? "settlement did not succeed");
  if (settlement.network !== expected.requirements.network) reject("settlement network mismatch");
  if (!TransactionId.safeParse(settlement.transaction).success) reject("transaction id is malformed");
  if (!AccountId.safeParse(settlement.payer).success || settlement.payer !== expected.payer) {
    reject("settlement payer mismatch");
  }
  if (settlement.amount !== undefined && settlement.amount !== expected.requirements.amount) {
    reject("settlement amount mismatch");
  }

  const wire = PaymentReceiptSchema.safeParse({
    missionId: expected.missionId,
    transactionId: settlement.transaction,
    network: expected.requirements.network,
    payer: settlement.payer,
    recipientAccountId: expected.requirements.payTo,
    asset: expected.requirements.asset,
    amountTinybar: expected.requirements.amount,
    settledAt: expected.observedAt,
  });
  if (!wire.success) reject("receipt does not satisfy the frozen contract");
  return { ...wire.data, amountTinybar: BigInt(wire.data.amountTinybar) };
}
