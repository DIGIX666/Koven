import type { Provider, RankedProvider } from "@koven/domain";

import { compareIds, filterCandidates, selectBest, type Criterion } from "./select.js";

export interface ProviderRankingInput {
  readonly capability: string;
  readonly maxPriceTinybar: bigint;
}

export const PROVIDER_RANKING_WEIGHTS = {
  price: 0.4,
  reputation: 0.4,
  latency: 0.2,
} as const;

export const PROVIDER_RANKING_FORMULA =
  "score = 0.4 * (1 - min(price / maxPrice, 1)) + 0.4 * reputation + 0.2 * (1 / (1 + latencyMs / 1000))";

const RATIO_SCALE = 1_000_000_000_000n;

const ratio = (numerator: bigint, denominator: bigint): number => {
  if (denominator === 0n) return numerator === 0n ? 0 : Number.POSITIVE_INFINITY;
  if (numerator <= 0n) return 0;
  return Number((numerator * RATIO_SCALE) / denominator) / Number(RATIO_SCALE);
};

const uniqueProviderIds = (providers: readonly Provider[]): boolean => {
  const ids = new Set(providers.map(provider => provider.id));
  return ids.size === providers.length;
};

export function rankProviders(
  providers: readonly Provider[],
  input: ProviderRankingInput,
): RankedProvider[] {
  if (input.capability.length === 0) throw new Error("Provider capability must not be empty");
  if (input.maxPriceTinybar < 0n) throw new Error("Maximum provider price must not be negative");
  if (!uniqueProviderIds(providers)) throw new Error("Provider ids must be unique");
  if (providers.some(provider => provider.priceTinybar < 0n
    || !Number.isFinite(provider.reputationScore)
    || provider.reputationScore < 0
    || provider.reputationScore > 1
    || !Number.isFinite(provider.expectedLatencyMs)
    || provider.expectedLatencyMs < 0)) {
    throw new Error("Provider ranking values are invalid");
  }

  const eligible = filterCandidates(providers, [provider => provider.capability === input.capability]);
  const criteria: Criterion<Provider>[] = [
    {
      key: "price",
      weight: PROVIDER_RANKING_WEIGHTS.price,
      score: provider => 1 - Math.min(ratio(provider.priceTinybar, input.maxPriceTinybar), 1),
    },
    {
      key: "reputation",
      weight: PROVIDER_RANKING_WEIGHTS.reputation,
      score: provider => provider.reputationScore,
    },
    {
      key: "latency",
      weight: PROVIDER_RANKING_WEIGHTS.latency,
      score: provider => 1 / (1 + provider.expectedLatencyMs / 1_000),
    },
  ];
  const selection = selectBest(eligible, criteria, (left, right) => compareIds(left.id, right.id));
  if (selection === null) return [];

  return selection.ranked.map(({ candidate, score, breakdown }) => ({
    provider: candidate,
    score,
    breakdown: {
      price: breakdown.price!,
      reputation: breakdown.reputation!,
      latency: breakdown.latency!,
    },
  }));
}
