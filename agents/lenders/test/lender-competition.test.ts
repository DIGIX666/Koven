import { readFile } from "node:fs/promises";

import { validateCreditOffer } from "@koven/credit-protocol";
import type { CreditOffer, CreditRequest } from "@koven/domain";
import { PrivateKey, type PublicKey } from "@koven/hedera";
import { selectCreditOffer } from "@koven/policy";
import { CreditOfferSchema } from "@koven/schemas";
import { afterEach, describe, expect, it } from "vitest";

import {
  COMPETITIVE_LENDER_POSTURE,
  CompetitiveLenderPolicy,
  CONSERVATIVE_LENDER_POSTURE,
  ConservativeLenderPolicy,
} from "../src/index.js";
import {
  closeRuntimes,
  lenderKey,
  listen,
  now,
  offerDomain,
  policy,
  quote,
  registerPolicy,
  runtime,
  signedRequest,
} from "./helpers.js";

const competitiveLenderKey = PrivateKey.generateECDSA();
const lenderAccounts = {
  conservative: "0.0.20",
  competitive: "0.0.21",
} as const;

const signatureValidator = (
  request: CreditRequest,
  publicKeys: ReadonlyMap<string, PublicKey>,
) => (candidate: CreditOffer): boolean => {
  const publicKey = publicKeys.get(candidate.lenderAccountId);
  if (publicKey === undefined) return false;
  try {
    validateCreditOffer(candidate, request, publicKey, now);
    return true;
  } catch {
    return false;
  }
};

const startMarketplace = async (principalTinybar: bigint) => {
  const conservative = runtime({
    lenderAccountId: lenderAccounts.conservative,
    lenderPrivateKey: lenderKey,
    lenderPolicy: new ConservativeLenderPolicy(),
  });
  const competitive = runtime({
    lenderAccountId: lenderAccounts.competitive,
    lenderPrivateKey: competitiveLenderKey,
    lenderPolicy: new CompetitiveLenderPolicy(),
  });
  const [conservativeUrl, competitiveUrl] = await Promise.all([
    listen(conservative.app),
    listen(competitive.app),
  ]);
  const missionPolicy = policy({
    spendingCapTinybar: principalTinybar.toString(10),
    sessionCapTinybar: principalTinybar.toString(10),
  });
  await Promise.all([
    registerPolicy(conservativeUrl, missionPolicy),
    registerPolicy(competitiveUrl, missionPolicy),
  ]);
  const request = signedRequest({
    id: `request-${principalTinybar.toString(10)}`,
    principalTinybar,
    requestedTermSeconds: 600,
  });
  const quoted = await Promise.all([
    quote(conservativeUrl, request),
    quote(competitiveUrl, request),
  ]);
  const offers = await Promise.all(quoted
    .filter(result => result.response.status === 200)
    .map(async result => offerDomain(CreditOfferSchema.parse(await result.response.json()))));
  return { conservativeUrl, competitiveUrl, request, quoted, offers };
};

afterEach(closeRuntimes);

describe("lender competition", () => {
  it("keeps the executable postures aligned with the shared fixture", async () => {
    const fixtureUrl = new URL("../../../tests/fixtures/lender-policies.json", import.meta.url);
    const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as unknown;

    expect(fixture).toEqual([
      {
        name: "conservative",
        maxPrincipalTinybar: CONSERVATIVE_LENDER_POSTURE.maxPrincipalTinybar.toString(10),
        feeBps: CONSERVATIVE_LENDER_POSTURE.feeBps,
        maxTermSeconds: CONSERVATIVE_LENDER_POSTURE.maxTermSeconds,
        minReputationScore: CONSERVATIVE_LENDER_POSTURE.minReputationScore,
      },
      {
        name: "competitive",
        maxPrincipalTinybar: COMPETITIVE_LENDER_POSTURE.maxPrincipalTinybar.toString(10),
        feeBps: COMPETITIVE_LENDER_POSTURE.feeBps,
        maxTermSeconds: COMPETITIVE_LENDER_POSTURE.maxTermSeconds,
        minReputationScore: COMPETITIVE_LENDER_POSTURE.minReputationScore,
      },
    ]);
  });

  it("applies the distinct reputation and term limits", () => {
    const conservative = new ConservativeLenderPolicy();
    const competitive = new CompetitiveLenderPolicy();
    const standard = signedRequest({ principalTinybar: 300_000_000n, requestedTermSeconds: 600 });
    const longerTerm = signedRequest({ principalTinybar: 300_000_000n, requestedTermSeconds: 1_200 });

    expect(conservative.evaluate(standard, 0.6)).toBeUndefined();
    expect(competitive.evaluate(standard, 0.6)).toMatchObject({ feeTinybar: 15_000_000n });
    expect(conservative.evaluate(longerTerm, 0.8)).toBeUndefined();
    expect(competitive.evaluate(longerTerm, 0.8)).toMatchObject({ termSeconds: 1_200 });
  });

  it("returns two distinguishable offers for a small request and selects the cheaper lender", async () => {
    const marketplace = await startMarketplace(300_000_000n);

    expect(marketplace.conservativeUrl).not.toBe(marketplace.competitiveUrl);
    expect(marketplace.quoted.map(result => result.response.status)).toEqual([200, 200]);
    expect(marketplace.offers).toHaveLength(2);
    expect(new Set(marketplace.offers.map(candidate => candidate.id)).size).toBe(2);
    expect(marketplace.offers.map(candidate => candidate.feeTinybar)).toEqual([6_000_000n, 15_000_000n]);

    const selected = selectCreditOffer(marketplace.offers, {
      requiredPrincipalTinybar: marketplace.request.principalTinybar,
      now,
      verifySignature: signatureValidator(marketplace.request, new Map([
        [lenderAccounts.conservative, lenderKey.publicKey],
        [lenderAccounts.competitive, competitiveLenderKey.publicKey],
      ])),
    });
    expect(selected?.winner.lenderAccountId).toBe(lenderAccounts.conservative);
  });

  it("declines the conservative cap and selects the competitive lender for a large request", async () => {
    const marketplace = await startMarketplace(2_000_000_000n);

    expect(marketplace.quoted.map(result => result.response.status)).toEqual([204, 200]);
    expect(marketplace.offers).toHaveLength(1);
    const selected = selectCreditOffer(marketplace.offers, {
      requiredPrincipalTinybar: marketplace.request.principalTinybar,
      now,
      verifySignature: signatureValidator(marketplace.request, new Map([
        [lenderAccounts.conservative, lenderKey.publicKey],
        [lenderAccounts.competitive, competitiveLenderKey.publicKey],
      ])),
    });
    expect(selected?.winner.lenderAccountId).toBe(lenderAccounts.competitive);
    expect(selected?.winner.feeTinybar).toBe(100_000_000n);
  });
});
