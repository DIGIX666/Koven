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
| ZK | Circom, snarkjs and Groth16; mandatory signer and independent lender verification in M3. | Real-circuit measurements remain A1.4's job. On-chain verification is deferred unless it gates settlement. |
| Artifacts | One official phase-2 release; immutable files, reviewed manifest and identical independently pinned verification keys. | New contributions change keys. Normal builds verify/download artifacts instead of regenerating canonical keys. Phase-2 contributor honesty remains an assumption. |
| Nonces and budgets | Canonical 248-bit nonce, unique `(mission_id, nonce)` and unique commitment; reserve budgets and consume nonce atomically before releasing signed bytes. | A new challenge must not make a reused nonce acceptable. Signer enforces mission and session caps. |
| Repayment | Immediate command derived from the accepted funded loan, with stable transaction ID and durable reconciliation. | Callback duplication must not cause a second transfer. Insufficient funds enter recovery/default; completion does not create repayment funds. |
| Audit | Agent Kit hook for lender funding only; explicit durable lifecycle outbox elsewhere. | Hook coverage excludes signer repayment and facilitator settlement; HCS failures must not lose local events. |
| Scope | No independent validator, decentralized dispute/default resolution, mainnet or new facilitator. ERC-8004/HCS-14 identity is excluded. | Keep the MVP focused on the credit/payment lifecycle. |
| Package naming | Existing packages remain `@koven/*`. Protocol signature domains use `koven:*` and the circuit identity is `koven-policy-v1`. | Keep package names, signed-message domains and circuit identity consistent before the first implementation release. |
| Delivery | One functional issue, branch and PR; multiple atomic commits allowed. F01 covers S0.0/S0.1. | Stable task IDs remain references; Git operations are handled by the developer. |

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
or service implementations. Workspace-wide tooling remains B0.4; transitions
remain B0.2. Subsequent changes to shared types, schemas or HTTP interfaces require
a `refactor(contract): …` PR with a brief rationale and explicit approval from
the other development track before merge. Keep `.gitkeep` only in directories
without real files.
