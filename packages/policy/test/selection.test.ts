import type { CreditOffer, Provider } from "@koven/domain";
import { describe, expect, it } from "vitest";

import {
  filterCandidates,
  PROVIDER_RANKING_WEIGHTS,
  rankProviders,
  selectBest,
  selectCreditOffer,
  weightedScore,
  type Criterion,
} from "../src/index.js";

const permutations = <T>(values: readonly T[]): T[][] => {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) => {
    const remaining = [...values.slice(0, index), ...values.slice(index + 1)];
    return permutations(remaining).map(rest => [value, ...rest]);
  });
};

const provider = (overrides: Partial<Provider> = {}): Provider => ({
  id: "provider-a",
  accountId: "0.0.1001",
  endpoint: "http://127.0.0.1:3003",
  capability: "solidity-scan",
  priceTinybar: 50n,
  reputationScore: 0.8,
  expectedLatencyMs: 1_000,
  ...overrides,
});

const offer = (overrides: Partial<CreditOffer> = {}): CreditOffer => ({
  id: "offer-a",
  requestId: "request-1",
  lenderAccountId: "0.0.2001",
  principalTinybar: 300_000_000n,
  feeTinybar: 6_000_000n,
  termSeconds: 600,
  expiresAt: "2026-09-13T10:10:00.000Z",
  termsHash: "a".repeat(64),
  signature: "valid",
  ...overrides,
});

describe("shared selection primitives", () => {
  interface Candidate { id: string; quality: number; available: boolean }
  const criteria: Criterion<Candidate>[] = [
    { key: "quality", weight: 0.75, score: candidate => candidate.quality },
    { key: "constant", weight: 0.25, score: () => 0.5 },
  ];

  it("filters without mutating candidates and exposes weighted contributions", () => {
    const candidates = [
      { id: "b", quality: 0.5, available: true },
      { id: "a", quality: 0.5, available: true },
      { id: "c", quality: 1, available: false },
    ];
    const eligible = filterCandidates(candidates, [candidate => candidate.available]);
    const selected = selectBest(eligible, criteria, (left, right) => left.id.localeCompare(right.id));

    expect(candidates.map(candidate => candidate.id)).toEqual(["b", "a", "c"]);
    expect(weightedScore(candidates[0]!, criteria)).toBe(0.5);
    expect(selected).toEqual({
      winner: candidates[1],
      ranked: [
        { candidate: candidates[1], score: 0.5, breakdown: { quality: 0.375, constant: 0.125 } },
        { candidate: candidates[0], score: 0.5, breakdown: { quality: 0.375, constant: 0.125 } },
      ],
    });
  });

  it("rejects invalid criteria instead of producing misleading rankings", () => {
    expect(() => weightedScore({ id: "a", quality: 1, available: true }, [
      { key: "quality", weight: -1, score: () => 1 },
    ])).toThrow("invalid weight");
    expect(() => weightedScore({ id: "a", quality: 1, available: true }, [
      { key: "quality", weight: 1, score: () => 1.1 },
    ])).toThrow("outside [0, 1]");
    expect(selectBest([], criteria, (left, right) => left.id.localeCompare(right.id))).toBeNull();
  });
});

describe("provider ranking", () => {
  const input = { capability: "solidity-scan", maxPriceTinybar: 100n };

  it("uses weighted price, reputation and latency contributions", () => {
    const ranked = rankProviders([provider()], input);

    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.breakdown.price).toBeCloseTo(0.2);
    expect(ranked[0]!.breakdown.reputation).toBeCloseTo(0.32);
    expect(ranked[0]!.breakdown.latency).toBeCloseTo(0.1);
    expect(ranked[0]!.score).toBeCloseTo(0.62);
  });

  it("hard-filters capabilities and deterministically breaks score ties by id", () => {
    const wrongCapability = provider({
      id: "ignored",
      capability: "dependency-audit",
      reputationScore: 1,
      priceTinybar: 0n,
      expectedLatencyMs: 0,
    });
    const tiedB = provider({ id: "provider-b", accountId: "0.0.1002" });
    const tiedA = provider();
    const ranked = rankProviders([wrongCapability, tiedB, tiedA], input);

    expect(ranked.map(entry => entry.provider.id)).toEqual(["provider-a", "provider-b"]);
  });

  it("handles a free provider under a zero budget without unsafe number conversion", () => {
    const free = provider({ priceTinybar: 0n });
    const expensive = provider({ id: "provider-b", accountId: "0.0.1002", priceTinybar: 1n });
    const ranked = rankProviders([expensive, free], { ...input, maxPriceTinybar: 0n });

    expect(ranked[0]!.provider.id).toBe("provider-a");
    expect(ranked[0]!.breakdown.price).toBe(PROVIDER_RANKING_WEIGHTS.price);
    expect(ranked[1]!.breakdown.price).toBe(0);
  });

  it("selects the same winner for every candidate permutation", () => {
    const candidates = [
      provider(),
      provider({ id: "provider-b", accountId: "0.0.1002", priceTinybar: 30n, reputationScore: 0.7 }),
      provider({ id: "provider-c", accountId: "0.0.1003", priceTinybar: 80n, reputationScore: 0.4 }),
    ];

    const winners = permutations(candidates).map(candidateOrder => rankProviders(candidateOrder, input)[0]!.provider.id);
    expect(new Set(winners)).toEqual(new Set(["provider-b"]));
  });
});

describe("credit offer selection", () => {
  const input = {
    requiredPrincipalTinybar: 300_000_000n,
    now: "2026-09-13T10:00:00.000Z",
    verifySignature: (candidate: CreditOffer) => candidate.signature === "valid",
  };

  it("filters invalid, expired and insufficient offers before ranking", () => {
    const cheaper = offer();
    const validButCostlier = offer({
      id: "offer-b",
      lenderAccountId: "0.0.2002",
      feeTinybar: 15_000_000n,
    });
    const invalidSignature = offer({ id: "offer-c", feeTinybar: 0n, signature: "invalid" });
    const expired = offer({ id: "offer-d", feeTinybar: 0n, expiresAt: input.now });
    const insufficient = offer({ id: "offer-e", principalTinybar: 299_999_999n, feeTinybar: 0n });
    const selected = selectCreditOffer(
      [invalidSignature, validButCostlier, expired, insufficient, cheaper],
      input,
    );

    expect(selected).not.toBeNull();
    expect(selected?.winner.id).toBe("offer-a");
    expect(selected?.ranked.map(entry => entry.offer.id)).toEqual(["offer-a", "offer-b"]);
    expect(selected!.ranked[0]!.score).toBeCloseTo(
      Object.values(selected!.ranked[0]!.breakdown).reduce((total, value) => total + value, 0),
    );
  });

  it("rewards useful headroom but penalizes excessive headroom", () => {
    const moderate = offer({ id: "moderate", principalTinybar: 110n, feeTinybar: 100n });
    const excessive = offer({ id: "excessive", principalTinybar: 200n, feeTinybar: 10n });
    const selected = selectCreditOffer([excessive, moderate], {
      ...input,
      requiredPrincipalTinybar: 100n,
    });

    expect(selected?.winner.id).toBe("moderate");
    expect(selected!.ranked[0]!.breakdown.headroom).toBeGreaterThan(selected!.ranked[1]!.breakdown.headroom);
  });

  it("selects the same offer for every candidate permutation", () => {
    const offers = [
      offer(),
      offer({ id: "offer-b", lenderAccountId: "0.0.2002", feeTinybar: 15_000_000n }),
      offer({ id: "offer-c", lenderAccountId: "0.0.2003", feeTinybar: 9_000_000n }),
    ];

    const winners = permutations(offers).map(candidateOrder => selectCreditOffer(candidateOrder, input)!.winner.id);
    expect(new Set(winners)).toEqual(new Set(["offer-a"]));
  });
});

it("breaks provider and offer ties in ASCII order for every input permutation", () => {
  const ids = ["A", "a", "a-", "a.", "a_"];
  for (const order of permutations(ids)) {
    expect(rankProviders(order.map(id => provider({ id })), { capability: "solidity-scan", maxPriceTinybar: 100n })
      .map(item => item.provider.id)).toEqual(ids);
    expect(selectCreditOffer(order.map(id => offer({ id })), { requiredPrincipalTinybar: 300_000_000n,
      now: "2026-09-13T10:00:00.000Z", verifySignature: () => true })?.ranked.map(item => item.offer.id)).toEqual(ids);
  }
});
