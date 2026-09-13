import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NormalizedChallenge } from "@koven/domain";
import { type FieldHasher, loadPoseidon, normalizeChallenge } from "@koven/x402";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_ARTIFACT_DIRECTORY, loadOfficialArtifacts, loadPinnedVerificationKey, type ProverArtifacts } from "../src/artifacts.js";
import { CIRCUIT_ID } from "../src/bundle.js";
import { prove, snarkjsGroth16Verifier } from "../src/prove.js";
import { verifyProofBundle } from "../src/verify.js";
import { buildMerkleTree, buildWitness } from "../src/witness.js";

const requirements = (amount: string, payTo: string) => ({
  scheme: "exact" as const,
  network: "hedera:testnet" as const,
  asset: "0.0.0" as const,
  amount,
  payTo,
  maxTimeoutSeconds: 180,
  extra: { feePayer: "0.0.3001" },
});
const scanUrl = "http://127.0.0.1:4401/scan";
const vectorChallenge: NormalizedChallenge = normalizeChallenge(requirements("1000000", "0.0.10396537"), "mission-zk-vector-v1", "0".repeat(64), "42", { scanUrl });
const VECTOR_COMMITMENT = "1026350485950336119746959985882780800617574155133227942712398221216121187747";
const VECTOR_ROOT = "9290366279921276004309573535909951682127199613521183526684654559243443935582";

let poseidon: FieldHasher;
let artifacts: ProverArtifacts;
let scratch: string;
beforeAll(async () => {
  poseidon = await loadPoseidon();
  artifacts = loadOfficialArtifacts();
  scratch = mkdtempSync(join(tmpdir(), "koven-prove-"));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("official artifacts", () => {
  it("loads only files that match the committed manifest", () => {
    expect(artifacts.vkeyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(artifacts.wasmPath.startsWith(DEFAULT_ARTIFACT_DIRECTORY)).toBe(true);
    expect(loadPinnedVerificationKey(join(DEFAULT_ARTIFACT_DIRECTORY, "verification_key.json"), artifacts.vkeyHash).vkeyHash).toBe(artifacts.vkeyHash);
    expect(() => loadPinnedVerificationKey(join(DEFAULT_ARTIFACT_DIRECTORY, "verification_key.json"), "0".repeat(64))).toThrowError(/pinned hash/);

    const tampered = join(scratch, "tampered");
    const bad = join(scratch, "bad-manifest.json");
    writeFileSync(bad, JSON.stringify({ circuitId: CIRCUIT_ID, vkeyHash: artifacts.vkeyHash, artifacts: {
      wasm: { file: "policy.wasm", sha256: "0".repeat(64) },
      zkey: { file: "policy_final.zkey", sha256: "0".repeat(64) },
      verificationKey: { file: "verification_key.json", sha256: artifacts.vkeyHash },
    } }));
    expect(() => loadOfficialArtifacts(DEFAULT_ARTIFACT_DIRECTORY, bad)).toThrowError(/does not match the manifest hash/);
    expect(() => loadOfficialArtifacts(tampered)).toThrowError(/missing; run pnpm zk:build/);
  });
});

describe("prove and verify on the official artifacts", () => {
  it("proves the fixed vector and verifies it independently with the real Groth16 verifier", async () => {
    const policy = { capTinybar: 2_000_000n, approvedRecipients: ["0.0.10396537"] };
    const witness = buildWitness(policy, vectorChallenge, poseidon);
    const bundle = await prove(witness.input, artifacts);

    expect(bundle.circuitId).toBe(CIRCUIT_ID);
    expect(bundle.vkeyHash).toBe(artifacts.vkeyHash);
    expect(bundle.publicSignals).toEqual([VECTOR_COMMITMENT, VECTOR_ROOT, "2000000"]);
    expect(bundle.publicSignals).toEqual(witness.publicSignals);

    const trusted = { vkey: artifacts.verificationKey, vkeyHash: artifacts.vkeyHash, approvedRoot: VECTOR_ROOT, maxCapTinybar: 2_000_000n };
    expect(await verifyProofBundle(bundle, trusted, { commitment: VECTOR_COMMITMENT })).toEqual({ ok: true });
    expect(await verifyProofBundle(bundle, trusted, { commitment: VECTOR_COMMITMENT }, snarkjsGroth16Verifier)).toEqual({ ok: true });

    // A tampered proof fails Groth16 verification before any binding check.
    const tampered = { ...bundle, proof: { ...bundle.proof, pi_c: [bundle.proof.pi_c[1], bundle.proof.pi_c[0], bundle.proof.pi_c[2]] as [string, string, string] } };
    expect(await verifyProofBundle(tampered, trusted, { commitment: VECTOR_COMMITMENT })).toEqual({ ok: false, code: "proof_invalid" });
    // The same valid proof is not bound to another mission's challenge.
    const other = normalizeChallenge(requirements("1000000", "0.0.10396537"), "mission-other", "0".repeat(64), "42", { scanUrl });
    const otherWitness = buildWitness(policy, other, poseidon);
    expect(await verifyProofBundle(bundle, trusted, { commitment: otherWitness.publicSignals[0] })).toEqual({ ok: false, code: "challenge_binding_mismatch" });
    // A claimed key hash that is not the verifier's own is refused even though the proof is valid.
    expect(await verifyProofBundle({ ...bundle, vkeyHash: "a".repeat(64) }, trusted, { commitment: VECTOR_COMMITMENT })).toEqual({ ok: false, code: "proof_vkey_mismatch" });
  });

  it("proves a recipient the verifier does not approve into a root that does not match", async () => {
    const provider = "0.0.2001";
    const challenge = normalizeChallenge(requirements("1000000", provider), "mission-1", "1".repeat(64), "7", { scanUrl });
    const witness = buildWitness({ capTinybar: 5_000_000n, approvedRecipients: [provider] }, challenge, poseidon);
    const bundle = await prove(witness.input, artifacts);
    const verifierRoot = buildMerkleTree(["0.0.10396537"], poseidon).root;

    expect(await verifyProofBundle(bundle, {
      vkey: artifacts.verificationKey, vkeyHash: artifacts.vkeyHash, approvedRoot: verifierRoot, maxCapTinybar: 5_000_000n,
    }, { commitment: witness.publicSignals[0] })).toEqual({ ok: false, code: "recipient_not_approved" });
    // And a proof made under a cap larger than the verifier allows is refused on the cap signal.
    expect(await verifyProofBundle(bundle, {
      vkey: artifacts.verificationKey, vkeyHash: artifacts.vkeyHash, approvedRoot: witness.publicSignals[1], maxCapTinybar: 4_999_999n,
    }, { commitment: witness.publicSignals[0] })).toEqual({ ok: false, code: "cap_exceeded" });
  });
});
