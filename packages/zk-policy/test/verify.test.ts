import type { ProofBundle } from "@koven/domain";
import { describe, expect, it, vi } from "vitest";

import { CIRCUIT_ID, parseProofBundle, verificationKeyHash } from "../src/bundle.js";
import { type Groth16Verifier, unavailableGroth16Verifier, verifyProofBundle } from "../src/verify.js";

// docs/zk-spike.md fixed vector: [commitment, root, cap].
const COMMITMENT = "1026350485950336119746959985882780800617574155133227942712398221216121187747";
const ROOT = "9290366279921276004309573535909951682127199613521183526684654559243443935582";
const VKEY_HASH = "2d23ff5d6058a4de330abee1fdc1b68905da223f9ad8bdb681d598e38b6a257d";

const bundle = (overrides: Partial<ProofBundle> = {}): ProofBundle => ({
  proof: {
    protocol: "groth16",
    curve: "bn128",
    pi_a: ["1", "2", "1"],
    pi_b: [["1", "2"], ["3", "4"], ["1", "0"]],
    pi_c: ["5", "6", "1"],
  },
  publicSignals: [COMMITMENT, ROOT, "2000000"],
  vkeyHash: VKEY_HASH,
  circuitId: CIRCUIT_ID,
  ...overrides,
});
const trusted = { vkey: { protocol: "groth16" }, vkeyHash: VKEY_HASH, approvedRoot: ROOT, maxCapTinybar: 2_000_000n };
const expected = { commitment: COMMITMENT };

/** Test-only Groth16 stand-in; production code must never inject it. */
const fakeGroth16Verifier = (accept: boolean): Groth16Verifier & { verify: ReturnType<typeof vi.fn> } => ({
  verify: vi.fn(async () => accept),
});

describe("verifyProofBundle", () => {
  it("fails closed with the production adapter until the real Groth16 verifier lands", async () => {
    expect(await verifyProofBundle(bundle(), trusted, expected)).toEqual({ ok: false, code: "proof_invalid" });
    expect(await verifyProofBundle(bundle(), trusted, expected, unavailableGroth16Verifier)).toEqual({ ok: false, code: "proof_invalid" });
  });

  it("accepts a consistent bundle only through an explicitly injected verifier", async () => {
    const verifier = fakeGroth16Verifier(true);
    expect(await verifyProofBundle(bundle(), trusted, expected, verifier)).toEqual({ ok: true });
    expect(verifier.verify).toHaveBeenCalledWith(trusted.vkey, bundle().publicSignals, bundle().proof);
    expect(await verifyProofBundle(bundle(), { ...trusted, maxCapTinybar: 2_000_001n }, expected, verifier)).toEqual({ ok: true });
  });

  it("checks in the frozen order: circuit id, own key hash, proof, commitment, root, cap", async () => {
    const accept = fakeGroth16Verifier(true);
    const reject = fakeGroth16Verifier(false);
    const claimedOtherKey = { ...trusted, vkeyHash: "a".repeat(64) };

    expect(await verifyProofBundle(bundle({ circuitId: "koven-policy-v2" }), trusted, expected, reject)).toEqual({ ok: false, code: "circuit_id_mismatch" });
    // The bundle's claimed hash is compared with the verifier's own hash, never accepted on its own.
    expect(await verifyProofBundle(bundle(), claimedOtherKey, expected, accept)).toEqual({ ok: false, code: "proof_vkey_mismatch" });
    expect(await verifyProofBundle(bundle({ vkeyHash: "a".repeat(64) }), trusted, expected, accept)).toEqual({ ok: false, code: "proof_vkey_mismatch" });
    expect(reject.verify).not.toHaveBeenCalled();
    expect(accept.verify).not.toHaveBeenCalled();

    expect(await verifyProofBundle(bundle(), trusted, expected, reject)).toEqual({ ok: false, code: "proof_invalid" });
    expect(await verifyProofBundle(bundle(), trusted, expected, { verify: async () => { throw new Error("verifier crashed"); } })).toEqual({ ok: false, code: "proof_invalid" });
    expect(await verifyProofBundle(bundle(), trusted, expected, { verify: async () => "true" as never })).toEqual({ ok: false, code: "proof_invalid" });

    expect(await verifyProofBundle(bundle(), trusted, { commitment: "1" }, accept)).toEqual({ ok: false, code: "challenge_binding_mismatch" });
    expect(await verifyProofBundle(bundle(), { ...trusted, approvedRoot: "1" }, expected, accept)).toEqual({ ok: false, code: "recipient_not_approved" });
    expect(await verifyProofBundle(bundle({ publicSignals: [COMMITMENT, ROOT, "2000001"] }), trusted, expected, accept)).toEqual({ ok: false, code: "cap_exceeded" });
  });

  it("rejects malformed bundles and non-canonical expectations without reaching the verifier", async () => {
    const accept = fakeGroth16Verifier(true);
    expect(await verifyProofBundle({ ...bundle(), publicSignals: [COMMITMENT, ROOT] } as never, trusted, expected, accept)).toEqual({ ok: false, code: "proof_invalid" });
    expect(await verifyProofBundle({ ...bundle(), proof: { ...bundle().proof, protocol: "plonk" } } as never, trusted, expected, accept)).toEqual({ ok: false, code: "proof_invalid" });
    expect(await verifyProofBundle({ ...bundle(), extra: 1 } as never, trusted, expected, accept)).toEqual({ ok: false, code: "proof_invalid" });
    expect(accept.verify).not.toHaveBeenCalled();
    expect(await verifyProofBundle(bundle(), trusted, { commitment: "01" }, accept)).toEqual({ ok: false, code: "challenge_binding_mismatch" });
    expect(await verifyProofBundle(bundle(), { ...trusted, vkeyHash: "not-a-hash" }, expected, accept)).toEqual({ ok: false, code: "proof_vkey_mismatch" });
  });
});

describe("bundle helpers", () => {
  it("parses the frozen wire shape and hashes exact key bytes", () => {
    expect(parseProofBundle(bundle())).toEqual(bundle());
    expect(() => parseProofBundle({ ...bundle(), circuitId: "" })).toThrow();
    const bytes = Buffer.from('{"protocol":"groth16"}\n', "utf8");
    expect(verificationKeyHash(bytes)).toMatch(/^[0-9a-f]{64}$/);
    expect(verificationKeyHash(bytes)).not.toBe(verificationKeyHash(Buffer.from('{"protocol":"groth16"}', "utf8")));
  });
});
