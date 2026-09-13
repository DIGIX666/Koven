import type { NormalizedChallenge } from "@koven/domain";
import { type FieldHasher, loadPoseidon, normalizeChallenge } from "@koven/x402";
import { beforeAll, describe, expect, it } from "vitest";

import { buildMerkleTree, buildWitness, emptyLeaf, MERKLE_LEAVES, WitnessError } from "../src/witness.js";

// docs/zk-spike.md fixed vector.
const VECTOR = {
  account: "0.0.10396537",
  recipient: "20090861577258363490916040138716814650710442748919609827874183591023274269588",
  resourceHash: "288031094563920303787641087997950259670691594399068952779151024896538021857",
  pathElements: [
    "14073517036565120802553032971283289133978697569878094600948169687927784805300",
    "10286088900531720834682469590504728414213434178091464684571742402538694044897",
    "14591368875189789628836098815252747228189821803919503374060259940612771979119",
  ],
  root: "9290366279921276004309573535909951682127199613521183526684654559243443935582",
  commitment: "1026350485950336119746959985882780800617574155133227942712398221216121187747",
} as const;

const challenge: NormalizedChallenge = normalizeChallenge({
  scheme: "exact",
  network: "hedera:testnet",
  asset: "0.0.0",
  amount: "1000000",
  payTo: VECTOR.account,
  maxTimeoutSeconds: 180,
  extra: { feePayer: "0.0.3001" },
}, "mission-zk-vector-v1", "0".repeat(64), "42", { scanUrl: "http://127.0.0.1:4401/scan" });

let poseidon: FieldHasher;
beforeAll(async () => {
  poseidon = await loadPoseidon();
});

const failure = (run: () => unknown, code: string) => {
  expect(run).toThrowError(WitnessError);
  try { run(); } catch (error) { expect((error as WitnessError).code).toBe(code); }
};

describe("buildMerkleTree", () => {
  it("reproduces the frozen singleton root and path", () => {
    const tree = buildMerkleTree([VECTOR.account], poseidon);
    expect(tree.root).toBe(VECTOR.root);
    expect(tree.leaves[0]).toBe(VECTOR.recipient);
    expect(tree.leaves.slice(1)).toEqual(Array(MERKLE_LEAVES - 1).fill(emptyLeaf(poseidon).toString(10)));
    expect(tree.pathFor(VECTOR.account)).toEqual({ pathElements: [...VECTOR.pathElements], pathIndices: [0, 0, 0] });
  });

  it("orders leaves canonically, so the root is independent of input order", () => {
    const forward = buildMerkleTree(["0.0.1", "0.0.2", "0.1.1", "1.0.0"], poseidon);
    const shuffled = buildMerkleTree(["1.0.0", "0.1.1", "0.0.2", "0.0.1"], poseidon);
    expect(shuffled.root).toBe(forward.root);
    expect(shuffled.leaves).toEqual(forward.leaves);
    expect(shuffled.pathFor("0.0.2").pathIndices).toEqual([1, 0, 0]);
    expect(shuffled.pathFor("1.0.0").pathIndices).toEqual([1, 1, 0]);
    // Numeric, not lexicographic: 0.0.10 sorts after 0.0.9.
    expect(buildMerkleTree(["0.0.10", "0.0.9"], poseidon).leaves[0]).toBe(buildMerkleTree(["0.0.9"], poseidon).leaves[0]);
  });

  it("recomputes every path against the root the way the circuit does", () => {
    const accounts = ["0.0.1", "0.0.2", "0.0.3", "0.0.4", "0.0.5"];
    const tree = buildMerkleTree(accounts, poseidon);
    for (const [index, account] of accounts.entries()) {
      const path = tree.pathFor(account);
      let node = BigInt(tree.leaves[index]!);
      for (let level = 0; level < path.pathElements.length; level += 1) {
        const sibling = BigInt(path.pathElements[level]!);
        node = path.pathIndices[level] === 0 ? poseidon([node, sibling]) : poseidon([sibling, node]);
      }
      expect(node.toString(10)).toBe(tree.root);
    }
  });

  it("rejects empty, oversized, duplicated or malformed recipient sets", () => {
    failure(() => buildMerkleTree([], poseidon), "request_invalid");
    failure(() => buildMerkleTree(Array.from({ length: 9 }, (_, i) => `0.0.${i + 1}`), poseidon), "request_invalid");
    failure(() => buildMerkleTree(["0.0.1", "0.0.1"], poseidon), "request_invalid");
    failure(() => buildMerkleTree(["0.0.01"], poseidon), "request_invalid");
    failure(() => buildMerkleTree(["0x1234"], poseidon), "request_invalid");
    failure(() => buildMerkleTree([VECTOR.account], poseidon).pathFor("0.0.2"), "recipient_not_approved");
  });
});

describe("buildWitness", () => {
  it("produces the frozen vector witness and its public signals", () => {
    const witness = buildWitness({ capTinybar: 2_000_000n, approvedRecipients: [VECTOR.account] }, challenge, poseidon);
    expect(witness.input).toEqual({
      amount: "1000000",
      recipient: VECTOR.recipient,
      nonce: "42",
      resourceHash: VECTOR.resourceHash,
      cap: "2000000",
      pathElements: [...VECTOR.pathElements],
      pathIndices: [0, 0, 0],
    });
    expect(witness.publicSignals).toEqual([VECTOR.commitment, VECTOR.root, "2000000"]);
  });

  it("fails at witness generation for an over-cap amount or a recipient outside the set", () => {
    failure(() => buildWitness({ capTinybar: 999_999n, approvedRecipients: [VECTOR.account] }, challenge, poseidon), "cap_exceeded");
    failure(() => buildWitness({ capTinybar: 2_000_000n, approvedRecipients: ["0.0.2001"] }, challenge, poseidon), "recipient_not_approved");
    failure(() => buildWitness({ capTinybar: 1n << 64n, approvedRecipients: [VECTOR.account] }, challenge, poseidon), "request_invalid");
  });
});
