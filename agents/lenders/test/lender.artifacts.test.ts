import { canonicalHash } from "@koven/credit-protocol";
import { ErrorCode } from "@koven/domain";
import { CreditAcceptResponseSchema, ErrorResponseSchema } from "@koven/schemas";
import { loadPoseidon, normalizeChallenge, type FieldHasher } from "@koven/x402";
import { buildWitness, DEFAULT_ARTIFACT_DIRECTORY, loadOfficialArtifacts, prove } from "@koven/zk-policy";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { LenderProofVerifier, loadLenderVerification } from "../src/index.js";
import { acceptanceWire, closeRuntimes, listen, policy, postAcceptance, quotedOffer, runtime, transactionId } from "./helpers.js";

const scanUrl = "https://provider.example/scan";
let poseidon: FieldHasher;
let artifacts: ReturnType<typeof loadOfficialArtifacts>;
let verifier: LenderProofVerifier;
beforeAll(async () => {
  poseidon = await loadPoseidon();
  artifacts = loadOfficialArtifacts();
  verifier = new LenderProofVerifier({
    poseidon,
    trusted: { verificationKey: artifacts.verificationKey, vkeyHash: artifacts.vkeyHash },
  });
});
afterEach(closeRuntimes);

const proveIntent = async (nonce: string) => {
  const requirements = {
    scheme: "exact", network: "hedera:testnet", asset: "0.0.0", amount: "100", payTo: "0.0.30",
    maxTimeoutSeconds: 180, extra: { feePayer: "0.0.40" },
  };
  const challenge = normalizeChallenge(requirements, "mission-1", "a".repeat(64), nonce, { scanUrl });
  const bundle = await prove(buildWitness({ capTinybar: 1_000n, approvedRecipients: ["0.0.30"] }, challenge, poseidon).input, artifacts);
  const wire = { ...challenge, amountTinybar: challenge.amountTinybar.toString(10) };
  return { wire, bundle, hashes: { paymentIntentHash: canonicalHash(wire), paymentProofBundleHash: canonicalHash(bundle) } };
};

describe("lender with real policy proofs", () => {
  it("funds a real proof bound to the signed intent and refuses rebinding or a foreign key hash", async () => {
    const test = runtime({ proofMode: "zk", proofVerifier: verifier });
    const baseUrl = await listen(test.app);
    const { request, offer } = await quotedOffer(baseUrl, policy({ approvedRecipientsRoot: verifier.rootFor("0.0.30") }));
    const proven = await proveIntent("1");

    // The same valid proof presented with another nonce: the recomputed commitment no longer matches.
    const rebound = { ...proven.wire, nonce: "2" };
    const reboundHashes = { paymentIntentHash: canonicalHash(rebound), paymentProofBundleHash: proven.hashes.paymentProofBundleHash };
    const mismatch = await postAcceptance(baseUrl, {
      ...acceptanceWire(request, offer, reboundHashes),
      paymentIntent: rebound,
      paymentProofBundle: proven.bundle,
    });
    expect(mismatch.status).toBe(400);
    expect(ErrorResponseSchema.parse(await mismatch.json()).code).toBe(ErrorCode.CHALLENGE_BINDING_MISMATCH);

    // Verifies under the official key, but claims another key hash: refused before verification.
    const forged = { ...proven.bundle, vkeyHash: "a".repeat(64) };
    const forgedResponse = await postAcceptance(baseUrl, {
      ...acceptanceWire(request, offer, { ...proven.hashes, paymentProofBundleHash: canonicalHash(forged) }),
      paymentIntent: proven.wire,
      paymentProofBundle: forged,
    });
    expect(forgedResponse.status).toBe(403);
    expect(ErrorResponseSchema.parse(await forgedResponse.json()).code).toBe(ErrorCode.PROOF_VKEY_MISMATCH);
    expect(test.gateway.transfers).toHaveLength(0);

    const funded = await postAcceptance(baseUrl, {
      ...acceptanceWire(request, offer, proven.hashes),
      paymentIntent: proven.wire,
      paymentProofBundle: proven.bundle,
    });
    expect(funded.status, await funded.clone().text()).toBe(200);
    expect(CreditAcceptResponseSchema.parse(await funded.json())).toEqual({ fundingTxId: transactionId });
    expect(test.gateway.transfers).toHaveLength(1);
  });

  it("loads its own verification key only when the file matches the configured pin", () => {
    const keyPath = `${DEFAULT_ARTIFACT_DIRECTORY}/verification_key.json`;
    const loaded = loadLenderVerification({
      LENDER_PROOF_MODE: "zk",
      LENDER_VERIFICATION_KEY_PATH: keyPath,
      LENDER_TRUSTED_VKEY_SHA256: artifacts.vkeyHash,
    });
    expect(loaded.proofMode).toBe("zk");
    expect(loaded.trusted?.vkeyHash).toBe(artifacts.vkeyHash);
    expect(() => loadLenderVerification({
      LENDER_PROOF_MODE: "zk",
      LENDER_VERIFICATION_KEY_PATH: keyPath,
      LENDER_TRUSTED_VKEY_SHA256: "b".repeat(64),
    })).toThrow(/pinned hash/);
  });
});
