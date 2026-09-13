import type { CreditOffer } from "@koven/domain";

import { canonicalHash } from "./canonical.js";

const UINT64_MAX = (1n << 64n) - 1n;

/** Stable identifier shared by the lender, signer and repayment orchestrator. */
export const loanIdForOffer = (offerId: string): string => (
  `loan-${canonicalHash({ offerId }).slice(0, 32)}`
);

/** The caller cannot override repayment recipient or amount. */
export const repaymentTerms = (
  offer: Pick<CreditOffer, "lenderAccountId" | "principalTinybar" | "feeTinybar">,
) => {
  const amountTinybar = offer.principalTinybar + offer.feeTinybar;
  if (offer.principalTinybar < 0n || offer.feeTinybar < 0n || amountTinybar > UINT64_MAX) {
    throw new RangeError("Repayment amount must fit uint64");
  }
  return { lenderAccountId: offer.lenderAccountId, amountTinybar };
};
