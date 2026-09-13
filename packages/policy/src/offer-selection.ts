import type { CreditOffer } from "@koven/domain";

import { filterCandidates, selectBest, type Criterion } from "./select.js";

export interface OfferSelectionInput {
  readonly requiredPrincipalTinybar: bigint;
  readonly now: string;
  readonly verifySignature: (offer: CreditOffer) => boolean;
}

export interface RankedCreditOffer {
  readonly offer: CreditOffer;
  readonly score: number;
  readonly breakdown: {
    readonly repayment: number;
    readonly headroom: number;
    readonly expiry: number;
  };
}

export interface CreditOfferSelection {
  readonly winner: CreditOffer;
  readonly ranked: RankedCreditOffer[];
}

export const OFFER_SELECTION_WEIGHTS = {
  repayment: 0.6,
  headroom: 0.2,
  expiry: 0.2,
} as const;

const RATIO_SCALE = 1_000_000_000_000n;

const ratio = (numerator: bigint, denominator: bigint): number => {
  if (denominator <= 0n) return numerator <= 0n ? 1 : 0;
  if (numerator <= 0n) return 0;
  return Number((numerator * RATIO_SCALE) / denominator) / Number(RATIO_SCALE);
};

const signatureIsValid = (
  offer: CreditOffer,
  verifySignature: OfferSelectionInput["verifySignature"],
): boolean => {
  try {
    return verifySignature(offer);
  } catch {
    return false;
  }
};

const uniqueOfferIds = (offers: readonly CreditOffer[]): boolean => {
  const ids = new Set(offers.map(offer => offer.id));
  return ids.size === offers.length;
};

const headroomScore = (principal: bigint, required: bigint): number => {
  if (required === 0n) return principal === 0n ? 1 : ratio(1n, 1n + principal);
  const headroom = principal - required;
  const ideal = required / 10n > 0n ? required / 10n : 1n;
  const distance = headroom >= ideal ? headroom - ideal : ideal - headroom;
  return ratio(ideal, ideal + distance);
};

export function selectCreditOffer(
  offers: readonly CreditOffer[],
  input: OfferSelectionInput,
): CreditOfferSelection | null {
  if (input.requiredPrincipalTinybar < 0n) throw new Error("Required principal must not be negative");
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) throw new Error("Offer selection time must be a valid timestamp");
  if (!uniqueOfferIds(offers)) throw new Error("Credit offer ids must be unique");

  const eligible = filterCandidates(offers, [
    offer => offer.principalTinybar >= input.requiredPrincipalTinybar,
    offer => offer.principalTinybar >= 0n && offer.feeTinybar >= 0n,
    offer => Date.parse(offer.expiresAt) > nowMs,
    offer => signatureIsValid(offer, input.verifySignature),
  ]);
  if (eligible.length === 0) return null;

  const repayments = eligible.map(offer => offer.principalTinybar + offer.feeTinybar);
  const minimumRepayment = repayments.reduce((minimum, value) => value < minimum ? value : minimum);
  const remainingTimes = eligible.map(offer => Date.parse(offer.expiresAt) - nowMs);
  const maximumRemainingTime = Math.max(...remainingTimes);
  const criteria: Criterion<CreditOffer>[] = [
    {
      key: "repayment",
      weight: OFFER_SELECTION_WEIGHTS.repayment,
      score: offer => {
        const repayment = offer.principalTinybar + offer.feeTinybar;
        return repayment === 0n ? 1 : ratio(minimumRepayment, repayment);
      },
    },
    {
      key: "headroom",
      weight: OFFER_SELECTION_WEIGHTS.headroom,
      score: offer => headroomScore(offer.principalTinybar, input.requiredPrincipalTinybar),
    },
    {
      key: "expiry",
      weight: OFFER_SELECTION_WEIGHTS.expiry,
      score: offer => (Date.parse(offer.expiresAt) - nowMs) / maximumRemainingTime,
    },
  ];
  const selection = selectBest(eligible, criteria, (left, right) => left.id.localeCompare(right.id));
  if (selection === null) return null;

  return {
    winner: selection.winner,
    ranked: selection.ranked.map(({ candidate, score, breakdown }) => ({
      offer: candidate,
      score,
      breakdown: {
        repayment: breakdown.repayment!,
        headroom: breakdown.headroom!,
        expiry: breakdown.expiry!,
      },
    })),
  };
}
