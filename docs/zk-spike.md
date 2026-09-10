# ZK policy feasibility spike

## Status

This document freezes the Policy V1 encoding before the circuit is implemented,
then records the artifact and performance results. The circuit
provides a portable payment-policy attestation. It does not make x402 payment
metadata confidential: only the Merkle authentication path is private.

## Circuit identity and field

- Circuit ID: `koven-policy-v1`.
- Proof system: Groth16 over BN254, using Circom 2.2.3 and SnarkJS.
- Scalar field modulus:
  `21888242871839275222246405745257275088548364400416034343698204186575808495617`.
- Every value crossing the Circom boundary is a canonical base-10 field element:
  `0` or a digit string without a leading zero, strictly below the field modulus.
- Public signals are ordered exactly as `[commitment, root, cap]`. Changing their
  meaning or order requires a new circuit ID.

## Canonical encodings

### Hedera account ID

Policy V1 accepts numeric Hedera account IDs only. Aliases, EVM addresses and
checksummed display forms are rejected rather than assigned a new encoding.

1. Parse the exact `shard.realm.num` form. Each component contains ASCII digits
   only and is represented canonically (`0`, or no leading zero).
2. Parse each component as an unsigned integer and reject it when it is greater
   than `2^64 - 1`.
3. Compute the recipient field element as
   `Poseidon([shard, realm, num])` using the BN254 Circomlib parameters.

The signer derives this value independently from the x402 `payTo` account. The
prover cannot supply an alternative account encoding.

### Resource hash

The canonical resource string is the exact UTF-8 encoding of:

```text
${method} ${url}\n${missionId}\n${targetSha256}
```

For Policy V1, `method` is the uppercase HTTP method, `url` is the validated
absolute scan URL used for the request, and `targetSha256` is 64 lowercase hex
characters computed over the exact source bytes. No Unicode, URL or newline
normalization is performed while constructing this string.

Hash the bytes with SHA-256 and discard the least-significant eight bits. In
hexadecimal this is the first 62 characters of the 64-character digest; parse
that value as an unsigned big-endian integer. The result is a 248-bit value and
is therefore always below the BN254 scalar modulus.

### Nonce

- Generate 31 cryptographically random bytes for every payment intent.
- Interpret them as an unsigned 248-bit big-endian integer.
- Carry the value as a canonical decimal string beside the x402 requirements;
  `PaymentRequirements` itself has no Koven nonce field.
- Reject negative values, leading-zero aliases and values greater than or equal
  to `2^248`.
- Persist uniqueness using the signer's `(mission_id, nonce)` primary key. A new
  amount, recipient or commitment does not make nonce reuse valid.

### Amount and cap

`amount` and `cap` are unsigned tinybar values constrained to 64 bits inside the
circuit with `Num2Bits(64)`. `LessEqThan(64)` proves `amount <= cap`. Protocol
validation is still responsible for rejecting a zero-priced or otherwise invalid
x402 challenge before proving.

## Recipient Merkle tree

- Hash: Circomlib Poseidon with two inputs for every internal node.
- Depth: 3, giving eight leaves.
- Real leaf: the account field element `Poseidon([shard, realm, num])`.
- Empty leaf: `Poseidon([0, 0, 0, 1])`. The different arity and final domain tag
  separate an unused slot from every three-input account leaf.
- Leaf order: canonical ascending numeric `(shard, realm, num)` order.
- Unused slots are appended after the real leaves and filled with the empty leaf.
- Path index: `0` means the current node is the left child; `1` means it is the
  right child. Every path index is constrained to be boolean in the circuit.

For the MVP, a mission provisions a root containing only its selected provider.
Candidate providers from the directory are never all approved at once. Repayment
uses the signer's separate `/repay` command, so lender accounts do not appear in
this tree.

## Payment commitment

The commitment is:

```text
Poseidon([amount, recipient, nonce, resourceHash])
```

The restricted signer reconstructs all four values from trusted mission state,
the received x402 requirements and the explicit nonce. It compares the computed
commitment with public signal zero before it verifies policy authorization.

## Policy V1 statement

Private witness values are `amount`, `recipient`, `nonce`, `resourceHash`, `cap`,
`pathElements[3]` and `pathIndices[3]`. Circuit outputs are public.

A valid proof establishes all of the following:

1. `amount` and `cap` fit in 64 bits and `amount <= cap`.
2. `nonce` and `resourceHash` fit in 248 bits.
3. `recipient` reaches public `root` through the supplied depth-three Poseidon
   Merkle path.
4. Public `commitment` binds the exact amount, recipient, nonce and resource hash.
5. Public `cap` is the cap used by the comparison constraint.

The proof alone does not authorize its public root or cap. Each verifier compares
those values to its own trusted mission policy and pins its own reviewed
verification key.

## Fixed-vector convention

Compatibility tests use the following semantic input vector. The generated decimal
Poseidon outputs are recorded here after the circuit and host-side vector tool
agree; they then become compatibility fixtures for `packages/x402` and the
restricted signer.

| Input | Value |
| --- | --- |
| Account | `0.0.10396537` |
| Amount | `1000000` |
| Cap | `2000000` |
| Nonce | `42` |
| Method | `POST` |
| URL | `http://127.0.0.1:4401/scan` |
| Mission ID | `mission-zk-vector-v1` |
| Target SHA-256 | `0000000000000000000000000000000000000000000000000000000000000000` |
| Recipient | `20090861577258363490916040138716814650710442748919609827874183591023274269588` |
| Resource SHA-256 | `a3051313512a544637a506fd964a16e8f1026c1af76eb9de9ed3ccfaaf8fe17d` |
| Resource hash | `288031094563920303787641087997950259670691594399068952779151024896538021857` |
| Root | `9290366279921276004309573535909951682127199613521183526684654559243443935582` |
| Commitment | `1026350485950336119746959985882780800617574155133227942712398221216121187747` |

The circuit is compiled with `--O2`. Circom reports 1,714 constraints, 1,718
wires, 11 private inputs, no public inputs and exactly three public outputs.

## Artifact release results

Pending the official artifact release.

## Measurements

Pending the benchmark run.

## Verification placement decision

Pending the benchmark results. Signer verification and independent lender verification are
already architectural requirements; the measurements will establish their cost
and whether any on-chain verifier has enough enforcement or audit value to
justify its inclusion.
