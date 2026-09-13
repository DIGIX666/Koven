import { createRequire } from "node:module";

import { CIRCUIT_ID, type Groth16Proof, parseProofBundle, type ProofBundle } from "./bundle.js";
import type { ProverArtifacts } from "./artifacts.js";
import type { Groth16Verifier } from "./verify.js";
import type { CircuitInput } from "./witness.js";

interface SnarkJs {
  groth16: {
    fullProve(input: Record<string, unknown>, wasmPath: string, zkeyPath: string): Promise<{ proof: unknown; publicSignals: string[] }>;
    verify(verificationKey: unknown, publicSignals: readonly string[], proof: unknown): Promise<boolean>;
  };
}

// snarkjs ships no type declarations; only this surface is used.
const snarkjs = createRequire(import.meta.url)("snarkjs") as SnarkJs;

/** The production Groth16 verifier: `snarkjs.groth16.verify` over the caller's own key. */
export const snarkjsGroth16Verifier: Groth16Verifier = {
  async verify(verificationKey: object, publicSignals: readonly string[], proof: Groth16Proof): Promise<boolean> {
    return (await snarkjs.groth16.verify(verificationKey, publicSignals, proof)) === true;
  },
};

/**
 * Proves a witness with the verified official artifacts and returns the frozen
 * bundle. `vkeyHash` is the manifest pin of the key these artifacts belong to;
 * verifiers compare it with their own pinned hash, never trust it.
 */
export async function prove(input: CircuitInput, artifacts: ProverArtifacts): Promise<ProofBundle> {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    { ...input, pathElements: [...input.pathElements], pathIndices: [...input.pathIndices] },
    artifacts.wasmPath,
    artifacts.zkeyPath,
  );
  return parseProofBundle({ proof, publicSignals, vkeyHash: artifacts.vkeyHash, circuitId: CIRCUIT_ID });
}
