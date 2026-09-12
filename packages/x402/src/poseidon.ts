import { createRequire } from "node:module";

import type { FieldHasher } from "./challenge.js";

interface PoseidonInstance {
  (inputs: readonly bigint[]): unknown;
  F: { toString(value: unknown): string };
}

interface CircomlibJs {
  buildPoseidon(): Promise<PoseidonInstance>;
}

// circomlibjs ships no type declarations; the same narrow surface is used by packages/zk-policy.
const circomlibjs = createRequire(import.meta.url)("circomlibjs") as CircomlibJs;

let cached: Promise<FieldHasher> | undefined;

/**
 * Loads the Circomlib Poseidon hash (BN254) once per process. Kept out of
 * `challenge.ts` so the normalization logic stays pure and I/O-free.
 */
export function loadPoseidon(): Promise<FieldHasher> {
  if (cached === undefined) {
    cached = circomlibjs.buildPoseidon().then(poseidon => (inputs: readonly bigint[]): bigint => (
      BigInt(poseidon.F.toString(poseidon(inputs)))
    ));
  }
  return cached;
}
