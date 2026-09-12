import { createHash } from "node:crypto";

import type { PaymentRequirements } from "@koven/domain";
import { beforeAll, describe, expect, it } from "vitest";

import {
  accountFieldElement,
  assertAcceptableRequirements,
  canonicalResourceString,
  challengeToFieldInputs,
  ChallengeRejectedError,
  type FieldHasher,
  normalizeChallenge,
  paymentCommitment,
  resourceHashFieldElement,
  resourceHashHex,
} from "../src/challenge.js";
import { loadPoseidon } from "../src/poseidon.js";

// docs/zk-spike.md — "Fixed-vector convention". These values are the compatibility
// fixture shared with packages/zk-policy/test/circuit.test.ts.
const VECTOR = {
  account: "0.0.10396537",
  amount: "1000000",
  nonce: "42",
  url: "http://127.0.0.1:4401/scan",
  missionId: "mission-zk-vector-v1",
  targetSha256: "0".repeat(64),
  recipient: "20090861577258363490916040138716814650710442748919609827874183591023274269588",
  resourceSha256: "a3051313512a544637a506fd964a16e8f1026c1af76eb9de9ed3ccfaaf8fe17d",
  resourceHash: "288031094563920303787641087997950259670691594399068952779151024896538021857",
  commitment: "1026350485950336119746959985882780800617574155133227942712398221216121187747",
} as const;

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "hedera:testnet",
  asset: "0.0.0",
  amount: VECTOR.amount,
  payTo: VECTOR.account,
  maxTimeoutSeconds: 180,
  extra: { feePayer: "0.0.3001" },
};
const context = { scanUrl: VECTOR.url };
const normalize = (candidate: unknown, nonce: string = VECTOR.nonce, missionId: string = VECTOR.missionId) => (
  normalizeChallenge(candidate, missionId, VECTOR.targetSha256, nonce, context)
);
const rejection = (run: () => unknown, reason: string) => {
  expect(run).toThrowError(ChallengeRejectedError);
  expect(run).toThrowError(reason);
  try { run(); } catch (error) { expect((error as ChallengeRejectedError).code).toBe("challenge_binding_mismatch"); }
};

let poseidon: FieldHasher;
beforeAll(async () => {
  poseidon = await loadPoseidon();
});

describe("canonical resource string", () => {
  it("is the exact UTF-8 frozen form with no normalization", () => {
    const value = canonicalResourceString("POST", VECTOR.url, VECTOR.missionId, VECTOR.targetSha256);
    expect(value).toBe(`POST ${VECTOR.url}\n${VECTOR.missionId}\n${VECTOR.targetSha256}`);
    expect(createHash("sha256").update(value, "utf8").digest("hex")).toBe(VECTOR.resourceSha256);
    expect(resourceHashHex(VECTOR.url, VECTOR.missionId, VECTOR.targetSha256)).toBe(VECTOR.resourceSha256);
  });
});

describe("normalizeChallenge", () => {
  it("normalises the fixed vector challenge", () => {
    expect(normalize(requirements)).toEqual({
      amountTinybar: 1_000_000n,
      recipientAccountId: VECTOR.account,
      nonce: VECTOR.nonce,
      resourceHash: VECTOR.resourceSha256,
      missionId: VECTOR.missionId,
    });
  });

  it("rejects every requirement it does not fully understand", () => {
    rejection(() => normalize({ ...requirements, scheme: "upto" }), "unsupported payment scheme");
    rejection(() => normalize({ ...requirements, network: "hedera:mainnet" }), "unsupported network");
    rejection(() => normalize({ ...requirements, asset: "0.0.456858" }), "unsupported asset");
    rejection(() => normalize({ ...requirements, extra: {} }), "fee payer is missing");
    rejection(() => normalize({ ...requirements, extra: undefined }), "fee payer is missing");
    rejection(() => normalize({ ...requirements, amount: "1.5" }), "frozen exact HBAR contract");
    rejection(() => normalize({ ...requirements, amount: "01" }), "frozen exact HBAR contract");
    rejection(() => normalize({ ...requirements, amount: 1_000_000 }), "frozen exact HBAR contract");
    rejection(() => normalize({ ...requirements, amount: "0" }), "zero-priced challenge");
    rejection(() => normalize({ ...requirements, payTo: "0x1234" }), "frozen exact HBAR contract");
    rejection(() => normalize({ ...requirements, outputSchema: {} }), "frozen exact HBAR contract");
    rejection(() => normalize({ ...requirements, extra: { feePayer: "0.0.3001", memo: "x" } }), "frozen exact HBAR contract");
    rejection(() => normalize(null), "unsupported payment scheme");
  });

  it("rejects malformed mission context before touching the requirements", () => {
    rejection(() => normalize(requirements, "042"), "nonce is not a canonical decimal");
    rejection(() => normalize(requirements, (1n << 248n).toString()), "nonce is not a canonical decimal");
    rejection(() => normalize(requirements, VECTOR.nonce, "mission id/with/slash"), "mission id is malformed");
    rejection(
      () => normalizeChallenge(requirements, VECTOR.missionId, "abc", VECTOR.nonce, context),
      "target hash is malformed",
    );
    rejection(
      () => normalizeChallenge(requirements, VECTOR.missionId, VECTOR.targetSha256, VECTOR.nonce, { scanUrl: "provider.invalid/scan" }),
      "scan URL is not an absolute HTTP URL",
    );
  });

  it("honours a configured policy instead of the defaults", () => {
    expect(() => assertAcceptableRequirements(requirements, { network: "hedera:testnet", asset: "0.0.0" })).not.toThrow();
  });
});

describe("field encodings", () => {
  it("matches the frozen Poseidon and resource-hash vector", () => {
    const inputs = challengeToFieldInputs(normalize(requirements), poseidon);
    expect(inputs).toEqual({
      amount: 1_000_000n,
      recipient: BigInt(VECTOR.recipient),
      nonce: 42n,
      resourceHash: BigInt(VECTOR.resourceHash),
    });
    expect(paymentCommitment(inputs, poseidon)).toBe(BigInt(VECTOR.commitment));
    expect(resourceHashFieldElement(VECTOR.resourceSha256)).toBe(BigInt(`0x${VECTOR.resourceSha256.slice(0, 62)}`));
    expect(resourceHashFieldElement(VECTOR.resourceSha256) < (1n << 248n)).toBe(true);
  });

  it("rejects account ids and amounts the circuit cannot encode", () => {
    rejection(() => accountFieldElement("0.0.18446744073709551616", poseidon), "exceeds 64 bits");
    rejection(() => accountFieldElement("0.0.01", poseidon), "canonical numeric account id");
    rejection(() => accountFieldElement("0x1234", poseidon), "canonical numeric account id");
    rejection(
      () => challengeToFieldInputs({ ...normalize(requirements), amountTinybar: 1n << 64n }, poseidon),
      "amount exceeds 64 bits",
    );
    rejection(() => resourceHashFieldElement("abc"), "resource hash is malformed");
  });
});
