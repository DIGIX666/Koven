# Decisions

## Status and references

This document records the agreed MVP architecture and the shared contracts
introduced by F01. It is the reference for the decisions and their rationale;
[the protocol](protocol.md) specifies the service interfaces and trust boundaries.
Service behavior is implemented in subsequent issues. Both development tracks
review shared contracts before merge.

## Resolved decisions

| Concern | Decision | Rationale / specification |
| --- | --- | --- |
| Paid service | Scan Solidity supplied inline with the request using Solhint in the MVP. | A clone can run without a Python toolchain; [source binding](protocol.md#source-and-completion-binding). |
| Settlement | Hedera testnet, x402 `exact`, HBAR asset `0.0.0`; tinybars on the wire are canonical decimal strings. | Avoid floating-point money; runtime facilitator fee payer comes from `/supported`. |
| Credit pricing | Risk-tiered offers from two distinct lender policies. Signed terms include principal, fee and term length. | Competition must produce distinguishable offers; B2/B4. |
| Funding | Direct transfer to the borrower's restricted wallet; no MVP escrow. | x402 does not supply credit escrow or solve default risk. |
| Consumer identity | Consumer has no key. Restricted signer exposes typed credit request and acceptance signing commands. | Prevent unrestricted signing and keep the payment key isolated; [credit binding](protocol.md#credit-signatures-and-loan-registration). |
| Loan synchronization | Lender-authenticated registration into signer-owned storage, verified against stored acceptance and Hedera funding. | Orchestrator cannot choose repayment destination or amount. |
| Completion | Valid source-bound report plus confirmed matching settlement, delivered through a provider-HMAC callback. | Delivery, not findings or severity, determines completion. HTTP response alone does not. |
| Callback transport | Configured callback URL, one provider secret per provider, durable retries, stable idempotency key. | Survive lost responses and process restarts; [callback authentication](protocol.md#callback-authentication-and-retries). |
| Discovery and reputation | Internal directory; deterministic ranking from local lifecycle events. M2/M3 use one configured provider; M4 introduces competition. | Keeps M3 independent of dynamic selection while retaining the M4 objective. |
| Selection | Share filtering, scoring and tie-breaking primitives; keep lender/provider policies distinct. | Different domains have different risk criteria. |
| Negotiation | Internal HTTP API; A2A/ACP deferred. | External negotiation protocols add no MVP value with controlled agents. |
| ZK | Circom, SnarkJS and Groth16; mandatory restricted-signer and independent-lender verification. No on-chain verifier for the MVP. | The measured verification cost is small, while a contract outside the Hedera `exact` settlement path cannot prevent an invalid payment. |
| Artifacts | One official phase-2 release; immutable files, reviewed manifest and identical independently pinned verification keys. | New contributions change keys. Normal builds verify/download artifacts instead of regenerating canonical keys. Phase-2 contributor honesty remains an assumption. |
| Nonces and budgets | Canonical 248-bit nonce, unique `(mission_id, nonce)` and unique commitment; reserve budgets and consume nonce atomically before releasing signed bytes. | A new challenge must not make a reused nonce acceptable. Signer enforces mission and session caps. |
| Repayment | Immediate command derived from the accepted funded loan, with stable transaction ID and durable reconciliation. | Callback duplication must not cause a second transfer. Insufficient funds enter recovery/default; completion does not create repayment funds. |
| Audit | Agent Kit hook for lender funding only; explicit durable lifecycle outbox elsewhere. | Hook coverage excludes signer repayment and facilitator settlement; HCS failures must not lose local events. |
| Scope | No independent validator, decentralized dispute/default resolution, mainnet or new facilitator. ERC-8004/HCS-14 identity is excluded. | Keep the MVP focused on the credit/payment lifecycle. |
| Package naming | Existing packages remain `@koven/*`. Protocol signature domains use `koven:*` and the circuit identity is `koven-policy-v1`. | Keep package names, signed-message domains and circuit identity consistent before the first implementation release. |
| Delivery | One functional issue, branch and PR; multiple atomic commits allowed. F01 covers S0.0/S0.1. | Stable task IDs remain references; Git operations are handled by the developer. |

## ZK verification placement

- The restricted signer verifies each proof before signing a payment and compares
  its public commitment, recipient root and cap with trusted mission state.
- The lender verifies the same proof independently, using its own pinned
  verification-key bytes and trusted copy of the mission policy. It does not
  inherit the signer's verification result.
- The MVP has no on-chain verifier. Hedera `exact` settlement is submitted as a
  transfer by the facilitator and is not gated by a Koven contract. An off-path
  verifier would add cost and complexity without enforcing settlement.
- On-chain verification is reconsidered only if a future settlement contract can
  reject invalid proofs before value moves, or if a concrete public-audit use
  case justifies publishing proofs.

The reproducible Policy V1 benchmark records ten post-warm-up samples on the
official artifacts. Median verification was 5.346 ms at the restricted signer
and 5.226 ms at the independent lender on the recorded development machine; see
[the feasibility measurements](zk-spike.md#measurements) for the environment,
ranges and measurement method.

## F03 implementation decisions

- Workspace commands use shared TypeScript, ESLint and Vitest configuration and
  must execute real package checks. Dependencies are pinned, and packages with
  native install steps are explicitly allowed through the root pnpm policy.
- Each service validates only its required environment variables at startup, so
  unrelated secrets do not need to exist in that process. Consumer and orchestrator
  views cannot expose the consumer private key. Pino recursively redacts private
  keys, signatures and raw signed transaction data, including child bindings.
- Mission lifecycle rules are represented by one exhaustive transition table.
  `assertTransition` rejects every undocumented edge with
  `illegal_state_transition`; `defaulted` and `closed` are terminal states.
- Each process opens its own SQLite database file. Signer-owned missions, loans,
  nonces and spending counters therefore remain outside orchestrator storage;
  no shared database singleton or implicit path crosses that trust boundary.
- SQLite runs versioned migrations with foreign keys, WAL and a bounded busy
  timeout. Tinybar values are canonical decimal `TEXT` and become `bigint` at
  application boundaries, so SQLite numeric coercion cannot lose uint64 precision.
- Payment reservation uses an immediate transaction: insert the unique
  `(mission_id, nonce)` and globally unique commitment, check mission and session
  caps with `bigint`, then compare-and-swap both counters. Any conflict or cap
  failure rolls back the nonce and every counter update. A successful reservation
  is retained when the external payment outcome is uncertain.
- Identical idempotency replays return the stored result; reusing a key with a
  different request hash raises `idempotency_conflict`. Local events use a database
  sequence to preserve insertion order when timestamps collide. Durable retry
  workers and service-specific outboxes remain in their owning later issues.

## PR contract refinements

- Paid scans carry a signer-signed authorization bound to the exact partially
  signed transaction bytes, mission and source. Providers verify it before
  settlement and durably deduplicate the payment. Source/hash consistency alone
  cannot establish that the signer authorized that scan.
- The trusted registrar provisions identical immutable mission policy to signer
  and candidate lenders. Lenders fail closed without this reference; pinning a
  circuit verification key does not authorize its public root or spending cap.

These refinements are proposed for review in this PR; the service implementations
and adversarial integration checks remain in the owning roadmap tasks.

## Contract ownership and validation

`packages/domain` contains in-memory types (money as `bigint`). `packages/schemas`
contains strict JSON schemas and inferred HTTP types (money as decimal strings).
`packages/audit` owns the public audit event catalogue and sink interface.
[Service interfaces](protocol.md#service-interfaces) defines authentication,
canonicalization, idempotency and semantic checks that parsing alone cannot prove.

Run:

```bash
pnpm install --frozen-lockfile
pnpm --filter @koven/domain --filter @koven/schemas --filter @koven/audit typecheck
pnpm --filter @koven/schemas test
```

F01 tests validate the contracts, not cryptographic authenticity, Hedera behavior
or complete service workflows. F03 supplies workspace checks, service-scoped
configuration, executable mission transitions and transactional local persistence.
Subsequent changes to shared types, schemas or HTTP interfaces require a
`refactor(contract): …` PR with a brief rationale and explicit approval from the
other development track before merge. Keep `.gitkeep` only in directories without
real files.


## A0.2 implementation decisions

- Pin `@hiero-ledger/sdk` to `2.86.2` and enforce it through the root pnpm
  override. F08 raised the original `2.85.0` pin because Hedera Agent Kit `4.1.0`
  requires `2.86.2`; the x402 and Agent Kit paths now share that SDK instance.
  `@koven/hedera` remains Koven's sole direct SDK importer. API usage and the
  existing x402 flow are checked against the installed version.
- Use Vitest `2.1.9` for the Hedera package with a shared root configuration base.
  Keep the existing contract tests unchanged; the live testnet test is an explicit
  command, excluded from ordinary `pnpm test`.
- Transfers debit only the client's operator, require an existing numeric target,
  and accept positive signed-int64 tinybars. Domain wire money remains uint64;
  larger values cannot be represented in Hedera's signed transfer amounts.
- A0.2 topic creation sets the operator admin key and leaves submission public
  to support the separate lender hooks planned in M5. A topic message is not
  authenticated merely because it appears on that topic; M5 must validate its
  expected payer and match it to trusted local event references/hashes.
- Submit only single-chunk HCS messages (1–1024 UTF-8 bytes). The mirror adapter
  returns one bounded ascending page with a sequence cursor, retains base64
  payloads, and rejects unsafe JSON integers rather than silently rounding them.
- The SDK's `@hiero-ledger/proto@2.31.0` dependency declares exact peer versions
  for `protobufjs` and `debug` that differ from the resolved patch versions. pnpm
  reports these upstream peer warnings. Keep the declared dependency graph rather
  than adding independent protobuf or debug overrides.

## A0.3 provisioning decisions

- Operational scripts import the SDK through `@koven/hedera` and read root `.env`
  with pinned `dotenv@16.6.1`. Require explicit testnet configuration and verify
  operator/role account keys with `AccountInfoQuery` before moving existing funds.
- Save generated ECDSA keys and transaction IDs in mode-0600 `.env` before
  submission. Atomic replacement, a process lock and refusal to overwrite manual
  edits protect provisioning state. Pending transactions are reconciled by ID;
  failed/expired receipt lookup requires manual reconciliation, not resubmission.
- Create missing non-operator accounts with 1 test HBAR by default. Existing IDs
  are validated and skipped; roles remain distinct. Funding commands require an
  explicit target balance and send only its shortfall.
- Provider recovery keys remain in provisioning-only `.env` variables; running
  scan services need no Hedera private key.

## A0.4 settlement decision

- The smoke test uses `@x402/hedera@2.24.0`'s `ExactHederaScheme` and
  `createClientHederaSigner`, with `HTTPFacilitatorClient` from `@x402/core@2.24.0`.
  It reads and validates the Hedera fee payer returned by Blocky402 `/supported`,
  then calls `/verify` and `/settle` through the official facilitator client.
- It saves the payment transaction ID before calling settlement once and checks
  the response's ID, payer and network. Mirror confirmation checks consensus
  success and the exact HBAR debit/credit. A rerun reconciles the saved ID instead
  of creating a new payment, whether the journal is pending or confirmed.
- SDK primitives used with x402 come from `@x402/hedera`'s re-exports, as required
  by the roadmap. An exact version override alone does not guarantee identical
  module instances when pnpm resolves different peer-dependency contexts.
- The successful 2026-09-06 test settled `1000000` tinybars to provider A and is
  recorded in `docs/setup.md` as public evidence. This validates the facilitator
  path, not the later paid resource-server middleware or Koven authorization gate.

## F08 implementation decisions

- Credit requests, offers and acceptances share one canonical JSON encoder.
  Signed bytes are UTF-8 `domain + "\\n" + canonicalJson`; Hedera ECDSA signatures
  cover every unsigned field, while tinybar `bigint` values become exact decimal
  strings before hashing.
- The conservative lender derives quotes only from its registered mission policy,
  trusted borrower key and local reputation input. It declines invalid limits and
  any principal-plus-fee result that would exceed uint64.
- Funding uses Hedera Agent Kit `4.1.0` in `AgentMode.AUTONOMOUS` and invokes
  `transfer_hbar_tool` directly. A post-core-action hook assigns and persists the
  transaction ID before the Agent Kit submits the built transfer.
- One SQLite reservation owns each accepted offer. A fenced, expiring
  compare-and-swap claim prevents concurrent or resumed workers from creating two
  transfers; once a transaction ID exists, retries reconcile it instead of
  resubmitting.
- Confirmed funding creates a durable signer-registration outbox entry. The
  lender reports success only after the signer acknowledges registration, while
  registration retries reuse the confirmed funding transaction.
