# ZK policy feasibility spike

## Status

This document records the frozen Policy V1 encoding, official artifacts and
performance results. The circuit provides a portable payment-policy attestation.
Within the proof, the amount, recipient, nonce, resource hash and Merkle path are
private witness values, while the cap, root and commitment are public. The x402
flow still reveals its payment metadata to its participants, so the proof does
not provide transaction confidentiality or network privacy.

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

The official setup uses the PSE Perpetual Powers of Tau contribution 0080,
prepared for phase 2 with 4,096 points. Its source is
`ppot_0080_12.ptau`, downloaded from the PSE public bucket. The exact file bytes
have SHA-256
`35e163120e724a60853d0dd76ec54037f7c7b00584392255f71a4341d5a05c50`,
and their complete contribution chain and final beacon were verified with
SnarkJS before the circuit-specific setup.

The circuit-specific phase 2 has one contribution by `kazai777`. This is an
explicit MVP trust assumption: the setup remains sound only if that contributor
discarded the generated entropy. The entropy is generated from the operating
system CSPRNG, passed to SnarkJS over standard input, and never written to the
transcript or process arguments.

| Artifact | SHA-256 |
| --- | --- |
| `policy.r1cs` | `8318f80b9ca1c1d8a4db94cfbe1ec74d5d4e82b5b22cd0fcaadb8c4d37149fbd` |
| `policy.wasm` | `5fe158c5bc17acd301413a275fc20c00c1169b8c79c7b5c29797ebac36d4fa30` |
| `policy_final.zkey` | `372bbf57cf025e143f91186502d3a18384abc5dc83a76e6250f9338079aff1d7` |
| `verification_key.json` | `2d23ff5d6058a4de330abee1fdc1b68905da223f9ad8bdb681d598e38b6a257d` |
| `phase2-transcript.txt` | `b98a55f381e93503a6522c606b17afdeb73b27abaa0e523582d34539f50a2b74` |

The reviewed manifest is `packages/zk-policy/artifacts-manifest.json`. Normal
builds compile the pinned sources, compare R1CS and WASM hashes, download missing
official artifacts over HTTPS, verify every byte-level hash, run `snarkjs zkey
verify`, and check that exporting the zkey reproduces the exact reviewed
verification-key file. A mismatched cache entry is never replaced automatically.

The setup command refuses to overwrite a release directory. Key rotation
requires a new circuit or artifact identity, a new reviewed manifest, and a new
versioned release; existing release assets and hashes are never replaced.

## Measurements

Measurements were taken on 2026-09-11 on an Apple M4 Pro (`arm64`) running
macOS/Darwin 25.6.0, Node.js 24.13.0, Circom 2.2.3 and SnarkJS 0.7.6. The test
uses the fixed vector above and the official released artifacts. It performs one
unmeasured warm-up followed by ten in-process samples. Times use a monotonic
clock and therefore exclude process startup and artifact download time.

| Measurement | Median | Observed range |
| --- | ---: | ---: |
| Witness construction | 26.554 ms | 25.950–29.362 ms |
| Groth16 proving | 53.650 ms | 52.589–60.707 ms |
| Restricted signer verification | 5.346 ms | 4.927–5.926 ms |
| Independent lender verification | 5.226 ms | 5.062–5.634 ms |
| Minified proof JSON size | 722.5 bytes | 720–725 bytes |

The compiled circuit has 1,714 constraints and exactly three public signals.
Proof size is the UTF-8 byte length of `JSON.stringify(proof)` and excludes the
three public-signal strings. Each sample constructs a new witness and randomized
proof, then verifies that proof twice against separately parsed copies of the
official verification key. These are feasibility measurements from one
development machine, not production latency guarantees; the executable test is
the reproducible source of the measurement method.

## Verification placement decision

The restricted signer must verify the proof before signing any payment. This is
the enforcement point that controls the consumer key and can reject a commitment,
root or cap that differs from trusted mission state.

The lender must independently verify the same proof bundle in its own process,
using its own pinned copy of the verification key and trusted mission policy.
The measured steady-state cost of roughly 5.3 ms per verifier is small relative
to the network payment flow and makes proof portability practical for the MVP.

No on-chain verifier is adopted for the MVP. Hedera `exact` settlement is a
facilitator-submitted transfer, so a verifier contract outside that path cannot
prevent an invalid payment. It would duplicate verification while adding
deployment, integration and operational complexity. Reconsider on-chain
verification only if settlement is changed so that a contract gates the transfer,
or if a concrete public-audit requirement justifies publishing proofs on-chain.
