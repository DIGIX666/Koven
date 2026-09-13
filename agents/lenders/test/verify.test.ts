import { canonicalHash } from "@koven/credit-protocol";
import { ErrorCode, type ProofBundle } from "@koven/domain";
import { CreditAcceptResponseSchema, ErrorResponseSchema } from "@koven/schemas";
import { challengeToFieldInputs, loadPoseidon, paymentCommitment, resourceHashHex, type FieldHasher } from "@koven/x402";
import { CIRCUIT_ID, type Groth16Verifier } from "@koven/zk-policy";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { LenderProofVerifier, loadLenderVerification } from "../src/index.js";
import {
  acceptanceWire,
  closeRuntimes,
  listen,
  policy,
  postAcceptance,
  quotedOffer,
  registerPolicy,
  runtime,
  transactionId,
} from "./helpers.js";

const lenderVkeyHash = "1".repeat(64);
const trusted = { verificationKey: { protocol: "groth16", curve: "bn128" }, vkeyHash: lenderVkeyHash };
const scanUrl = "https://provider.example/scan";
const intent = (overrides: Partial<Record<"amountTinybar" | "recipientAccountId" | "nonce" | "resourceHash" | "missionId", string>> = {}) => ({
  amountTinybar: "100",
  recipientAccountId: "0.0.30",
  nonce: "7",
  resourceHash: resourceHashHex(scanUrl, "mission-1", "a".repeat(64)),
  missionId: "mission-1",
  ...overrides,
});

let poseidon: FieldHasher;
let verifier: LenderProofVerifier;
let singletonRoot: string;
/** Test seam: accepts every Groth16 proof so binding, root, cap and key checks are exercised alone. */
const fakeGroth16Verifier = (): Groth16Verifier => ({ verify: vi.fn(async () => true) });

beforeAll(async () => {
  poseidon = await loadPoseidon();
  verifier = new LenderProofVerifier({ poseidon, trusted, verifier: fakeGroth16Verifier() });
  singletonRoot = verifier.rootFor("0.0.30");
});
afterEach(closeRuntimes);

const commitmentFor = (wire: ReturnType<typeof intent>): string => paymentCommitment(
  challengeToFieldInputs({ ...wire, amountTinybar: BigInt(wire.amountTinybar) }, poseidon),
  poseidon,
).toString(10);

/** Internally consistent bundle for the intent: commitment, singleton root and mission cap. */
const bundleFor = (wire: ReturnType<typeof intent>, overrides: Partial<ProofBundle> = {}): ProofBundle => ({
  proof: {
    protocol: "groth16",
    curve: "bn128",
    pi_a: ["1", "2", "1"],
    pi_b: [["1", "2"], ["3", "4"], ["1", "0"]],
    pi_c: ["5", "6", "1"],
  },
  publicSignals: [commitmentFor(wire), singletonRoot, "1000"],
  vkeyHash: lenderVkeyHash,
  circuitId: CIRCUIT_ID,
  ...overrides,
});

const zkPolicy = () => policy({ approvedRecipientsRoot: singletonRoot });

const zkRuntime = (groth16: Groth16Verifier = fakeGroth16Verifier()) => runtime({
  proofMode: "zk",
  proofVerifier: new LenderProofVerifier({ poseidon, trusted, verifier: groth16 }),
});

const evidenceFor = (wire: ReturnType<typeof intent>, bundle: ProofBundle) => ({
  paymentIntent: wire,
  paymentProofBundle: bundle,
  hashes: { paymentIntentHash: canonicalHash(wire), paymentProofBundleHash: canonicalHash(bundle) },
});

describe("lender-side independent proof verification", () => {
  it("funds only after verifying the bundle against its own key, the local policy and the signed intent", async () => {
    const groth16 = fakeGroth16Verifier();
    const test = zkRuntime(groth16);
    const baseUrl = await listen(test.app);
    const { request, offer } = await quotedOffer(baseUrl, zkPolicy());
    const wire = intent();
    const bundle = bundleFor(wire);
    const evidence = evidenceFor(wire, bundle);

    const response = await postAcceptance(baseUrl, {
      ...acceptanceWire(request, offer, evidence.hashes),
      paymentIntent: wire,
      paymentProofBundle: bundle,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(CreditAcceptResponseSchema.parse(await response.json())).toEqual({ fundingTxId: transactionId });
    expect(groth16.verify).toHaveBeenCalledWith(trusted.verificationKey, bundle.publicSignals, bundle.proof);
    expect(test.gateway.transfers).toHaveLength(1);
  });

  it("declines a mismatched vkeyHash even when proof and signals are internally consistent", async () => {
    const groth16 = fakeGroth16Verifier();
    const test = zkRuntime(groth16);
    const baseUrl = await listen(test.app);
    const { request, offer } = await quotedOffer(baseUrl, zkPolicy());
    const wire = intent();
    const bundle = bundleFor(wire, { vkeyHash: "a".repeat(64) });
    const evidence = evidenceFor(wire, bundle);

    const response = await postAcceptance(baseUrl, {
      ...acceptanceWire(request, offer, evidence.hashes),
      paymentIntent: wire,
      paymentProofBundle: bundle,
    });
    expect(response.status).toBe(403);
    expect(ErrorResponseSchema.parse(await response.json()).code).toBe(ErrorCode.PROOF_VKEY_MISMATCH);
    expect(groth16.verify).not.toHaveBeenCalled();
    expect(test.gateway.transfers).toHaveLength(0);
  });

  it("refuses an intent for another mission, provider, source or amount before any proof work", async () => {
    const groth16 = fakeGroth16Verifier();
    const test = zkRuntime(groth16);
    const baseUrl = await listen(test.app);
    const { request, offer } = await quotedOffer(baseUrl, zkPolicy());
    const cases = [
      intent({ missionId: "mission-2" }),
      intent({ recipientAccountId: "0.0.31" }),
      intent({ resourceHash: resourceHashHex(scanUrl, "mission-1", "b".repeat(64)) }),
      intent({ resourceHash: resourceHashHex("https://other.example/scan", "mission-1", "a".repeat(64)) }),
      // Larger than the offer principal that finances it.
      intent({ amountTinybar: "101" }),
    ];
    for (const wire of cases) {
      const bundle = bundleFor(wire);
      const response = await postAcceptance(baseUrl, {
        ...acceptanceWire(request, offer, evidenceFor(wire, bundle).hashes),
        paymentIntent: wire,
        paymentProofBundle: bundle,
      });
      expect(response.status).toBe(403);
      expect(ErrorResponseSchema.parse(await response.json()).code).toBe(ErrorCode.MISSION_POLICY_MISMATCH);
    }
    expect(groth16.verify).not.toHaveBeenCalled();
    expect(test.gateway.transfers).toHaveLength(0);
  });

  it("refuses a verifying proof whose root, cap or commitment is not the policy's", async () => {
    const test = zkRuntime();
    const baseUrl = await listen(test.app);
    const { request, offer } = await quotedOffer(baseUrl, zkPolicy());
    const wire = intent();
    const cases: [ProofBundle, string, number][] = [
      [bundleFor(wire, { publicSignals: [commitmentFor(wire), verifier.rootFor("0.0.31"), "1000"] }), ErrorCode.RECIPIENT_NOT_APPROVED, 403],
      [bundleFor(wire, { publicSignals: [commitmentFor(wire), singletonRoot, "1001"] }), ErrorCode.CAP_EXCEEDED, 403],
      [bundleFor(wire, { publicSignals: [commitmentFor(wire), singletonRoot, "999"] }), ErrorCode.MISSION_POLICY_MISMATCH, 403],
      [bundleFor(wire, { publicSignals: [commitmentFor(intent({ nonce: "8" })), singletonRoot, "1000"] }), ErrorCode.CHALLENGE_BINDING_MISMATCH, 400],
      [bundleFor(wire, { circuitId: "koven-policy-v0" }), ErrorCode.CIRCUIT_ID_MISMATCH, 403],
    ];
    for (const [bundle, code, status] of cases) {
      const response = await postAcceptance(baseUrl, {
        ...acceptanceWire(request, offer, evidenceFor(wire, bundle).hashes),
        paymentIntent: wire,
        paymentProofBundle: bundle,
      });
      expect(response.status).toBe(status);
      expect(ErrorResponseSchema.parse(await response.json()).code).toBe(code);
    }
    expect(test.gateway.transfers).toHaveLength(0);
  });

  it("requires evidence in zk mode and the selected provider's singleton root at registration", async () => {
    const test = zkRuntime();
    const baseUrl = await listen(test.app);
    const wrongRoot = await registerPolicy(baseUrl, policy());
    expect(wrongRoot.status).toBe(403);
    expect(ErrorResponseSchema.parse(await wrongRoot.json()).code).toBe(ErrorCode.MISSION_POLICY_MISMATCH);

    const { request, offer } = await quotedOffer(baseUrl, zkPolicy());
    const bare = await postAcceptance(baseUrl, acceptanceWire(request, offer));
    expect(bare.status).toBe(400);
    expect(ErrorResponseSchema.parse(await bare.json()).code).toBe(ErrorCode.REQUEST_INVALID);
    expect(test.gateway.transfers).toHaveLength(0);
  });

  it("fails closed when zk mode is configured without a pinned key", () => {
    expect(() => runtime({ proofMode: "zk" })).toThrow(/pinned verification key/);
    expect(loadLenderVerification({})).toEqual({ proofMode: "deterministic" });
    expect(() => loadLenderVerification({ LENDER_PROOF_MODE: "zk" })).toThrow(/LENDER_VERIFICATION_KEY_PATH/);
    expect(() => loadLenderVerification({ LENDER_PROOF_MODE: "other" })).toThrow(/LENDER_PROOF_MODE/);
  });
});
