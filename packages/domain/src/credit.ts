export interface CreditRequest {
  id: string; missionId: string; borrowerAccountId: string;
  principalTinybar: bigint; requestedTermSeconds: number;
  purposeHash: string; createdAt: string; signature: string;
}
export type UnsignedCreditRequest = Omit<CreditRequest, "signature">;
export interface CreditOffer {
  id: string; requestId: string; lenderAccountId: string;
  principalTinybar: bigint; feeTinybar: bigint; termSeconds: number;
  expiresAt: string; termsHash: string; signature: string;
}
export interface CreditAcceptance {
  requestId: string; missionId: string; borrowerAccountId: string;
  lenderAccountId: string; offerId: string; termsHash: string;
  expiresAt: string; paymentIntentHash?: string; paymentProofBundleHash?: string;
}
export type LoanState = "offered" | "accepted" | "funded" | "repaid" | "defaulted";
export interface Loan {
  id: string; offerId: string; missionId: string; lenderAccountId: string;
  principalTinybar: bigint; feeTinybar: bigint; state: LoanState;
  fundingTxId?: string; repaymentTxId?: string;
}
export const CREDIT_SIGNATURE_DOMAINS = {
  request: "koven:credit-request:v1",
  offer: "koven:credit-offer:v1",
  acceptance: "koven:credit-acceptance:v1",
} as const;
