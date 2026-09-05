export interface PaymentPolicyInput {
  paymentAmountTinybar: bigint;
  missionSpendingCapTinybar: bigint;
  missionSpentTinybar: bigint;
  recipientAccountId: string;
  resourceHash: string;
  nonce: string;
}

/** Prevents both a single oversized payment and cumulative budget overflow. */
export function isWithinMissionBudget(input: PaymentPolicyInput): boolean {
  return (
    input.paymentAmountTinybar >= 0n &&
    input.missionSpentTinybar >= 0n &&
    input.paymentAmountTinybar <=
      input.missionSpendingCapTinybar - input.missionSpentTinybar
  );
}

