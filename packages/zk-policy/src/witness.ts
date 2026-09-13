import { ErrorCode, type NormalizedChallenge } from "@koven/domain";
import { accountFieldElement, challengeToFieldInputs, type FieldHasher, paymentCommitment } from "@koven/x402";

import type { PublicSignals } from "./bundle.js";

/** Depth of the approved-recipient tree frozen in docs/zk-spike.md (eight leaves). */
export const MERKLE_DEPTH = 3;
export const MERKLE_LEAVES = 2 ** MERKLE_DEPTH;
const UINT64_MAX = (1n << 64n) - 1n;
const ACCOUNT_ID = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type WitnessCode =
  | typeof ErrorCode.CAP_EXCEEDED
  | typeof ErrorCode.RECIPIENT_NOT_APPROVED
  | typeof ErrorCode.REQUEST_INVALID;

export class WitnessError extends Error {
  constructor(readonly code: WitnessCode, detail: string) {
    super(detail);
    this.name = "WitnessError";
  }
}

function reject(code: WitnessCode, detail: string): never {
  throw new WitnessError(code, detail);
}

export interface MissionPolicy {
  /** Mission spending cap; the public `cap` signal. */
  readonly capTinybar: bigint;
  /** Canonical numeric account IDs the mission may pay; one selected provider in the MVP. */
  readonly approvedRecipients: readonly string[];
}

export interface MerklePath {
  readonly pathElements: readonly string[];
  /** `0` when the current node is the left child, `1` when it is the right child. */
  readonly pathIndices: readonly number[];
}

export interface MerkleTree {
  readonly root: string;
  /** Leaf field elements in canonical ascending `(shard, realm, num)` order, empty slots appended. */
  readonly leaves: readonly string[];
  pathFor(accountId: string): MerklePath;
}

/** `Poseidon([0, 0, 0, 1])`: a four-input hash with a domain tag, distinct from every account leaf. */
export const emptyLeaf = (poseidon: FieldHasher): bigint => poseidon([0n, 0n, 0n, 1n]);

const accountParts = (accountId: string): [bigint, bigint, bigint] => {
  const match = ACCOUNT_ID.exec(accountId);
  if (!match) reject(ErrorCode.REQUEST_INVALID, `Approved recipient is not a canonical numeric account id: ${accountId}`);
  const parts = [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)] as [bigint, bigint, bigint];
  if (parts.some(part => part > UINT64_MAX)) reject(ErrorCode.REQUEST_INVALID, "Account component exceeds 64 bits");
  return parts;
};

const compareAccounts = (left: string, right: string): number => {
  const a = accountParts(left);
  const b = accountParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
};

/**
 * The frozen recipient tree: Circomlib Poseidon, depth 3, account leaves
 * `Poseidon([shard, realm, num])` in canonical ascending order, unused slots
 * filled with the empty leaf. Host and circuit must agree byte for byte; the
 * fixed-vector test guards that.
 */
export function buildMerkleTree(accountIds: readonly string[], poseidon: FieldHasher): MerkleTree {
  if (accountIds.length === 0) reject(ErrorCode.REQUEST_INVALID, "An approved recipient set cannot be empty");
  if (accountIds.length > MERKLE_LEAVES) reject(ErrorCode.REQUEST_INVALID, `At most ${MERKLE_LEAVES} approved recipients fit the tree`);
  for (const accountId of accountIds) accountParts(accountId);
  const sorted = [...accountIds].sort(compareAccounts);
  for (let index = 1; index < sorted.length; index += 1) {
    if (compareAccounts(sorted[index - 1]!, sorted[index]!) === 0) {
      reject(ErrorCode.REQUEST_INVALID, `Duplicate approved recipient: ${sorted[index]}`);
    }
  }
  const empty = emptyLeaf(poseidon);
  const leaves: bigint[] = sorted.map(accountId => accountFieldElement(accountId, poseidon));
  while (leaves.length < MERKLE_LEAVES) leaves.push(empty);

  const levels: bigint[][] = [leaves];
  for (let depth = 0; depth < MERKLE_DEPTH; depth += 1) {
    const current = levels[depth]!;
    const next: bigint[] = [];
    for (let index = 0; index < current.length; index += 2) {
      next.push(poseidon([current[index]!, current[index + 1]!]));
    }
    levels.push(next);
  }
  const root = levels[MERKLE_DEPTH]![0]!;

  return {
    root: root.toString(10),
    leaves: leaves.map(leaf => leaf.toString(10)),
    pathFor(accountId: string): MerklePath {
      const position = sorted.findIndex(candidate => compareAccounts(candidate, accountId) === 0);
      if (position === -1) reject(ErrorCode.RECIPIENT_NOT_APPROVED, "Recipient is not in the approved set");
      const pathElements: string[] = [];
      const pathIndices: number[] = [];
      let index = position;
      for (let depth = 0; depth < MERKLE_DEPTH; depth += 1) {
        const sibling = index % 2 === 0 ? index + 1 : index - 1;
        pathElements.push(levels[depth]![sibling]!.toString(10));
        pathIndices.push(index % 2);
        index = Math.floor(index / 2);
      }
      return { pathElements, pathIndices };
    },
  };
}

/** Every value crossing the Circom boundary is a canonical decimal string. */
export interface CircuitInput {
  readonly amount: string;
  readonly recipient: string;
  readonly nonce: string;
  readonly resourceHash: string;
  readonly cap: string;
  readonly pathElements: readonly string[];
  readonly pathIndices: readonly number[];
}

export interface Witness {
  readonly input: CircuitInput;
  /** `[commitment, root, cap]` the circuit will output for this input. */
  readonly publicSignals: PublicSignals;
}

/**
 * Builds the private witness from the mission policy and a normalized
 * challenge. An amount above the cap or a recipient outside the approved set
 * fails here, before any proving work.
 */
export function buildWitness(policy: MissionPolicy, challenge: NormalizedChallenge, poseidon: FieldHasher): Witness {
  if (policy.capTinybar < 0n || policy.capTinybar > UINT64_MAX) reject(ErrorCode.REQUEST_INVALID, "Cap must fit 64 bits");
  const fields = challengeToFieldInputs(challenge, poseidon);
  if (fields.amount > policy.capTinybar) reject(ErrorCode.CAP_EXCEEDED, "Payment amount exceeds the mission cap");
  const tree = buildMerkleTree(policy.approvedRecipients, poseidon);
  const path = tree.pathFor(challenge.recipientAccountId);
  return {
    input: {
      amount: fields.amount.toString(10),
      recipient: fields.recipient.toString(10),
      nonce: fields.nonce.toString(10),
      resourceHash: fields.resourceHash.toString(10),
      cap: policy.capTinybar.toString(10),
      pathElements: path.pathElements,
      pathIndices: path.pathIndices,
    },
    publicSignals: [paymentCommitment(fields, poseidon).toString(10), tree.root, policy.capTinybar.toString(10)],
  };
}
