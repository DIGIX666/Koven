# Threat model

## Failure modes this project responds to

x402 enables HTTP-native payments, but payment authorization alone does not make autonomous spending safe or solve the operational constraints faced by AI agents.

| Failure mode | Consequence | Koven response |
| --- | --- | --- |
| Insufficient working capital | An agent cannot complete a potentially profitable mission because it cannot pay for the required services upfront | Competing lender agents provide short-lived credit offers |
| Uncontrolled provider selection | An agent may choose an expensive, unreliable, or unsuitable service | Providers are ranked by price, reputation, latency, capability, and historical reliability |
| Prompt injection or poisoned context | A compromised agent may attempt to increase a payment amount or redirect funds | The signer requires a ZK proof enforcing the spending cap and approved-recipient set |
| Software-only policy enforcement | A malicious prompt may influence application logic executed in the same agent context | Payment policy is verified inside an isolated signing boundary |
| Proof or payment replay | A valid authorization may be reused for another resource, amount, recipient, or transaction | Each proof is bound to the x402 challenge, resource, amount, recipient, and nonce |
| Duplicate completion callbacks | The same mission may trigger multiple repayments | Callbacks and repayments use idempotency keys and explicit lifecycle states |
| Missing financial traceability | Credit decisions, payments, and repayments are difficult to audit across agents | Critical lifecycle events are referenced through an HCS audit trail |
| Failed or unprofitable mission | The borrower may be unable to repay the lender | The MVP exposes this risk explicitly and does not claim to solve decentralized default or dispute resolution |

## Threats addressed by the MVP

- Prompt injection attempting to raise the payment amount.
- Prompt injection attempting to redirect payment to another recipient.
- Agent selecting an expired or malformed loan offer.
- Duplicate mission callbacks causing double repayment.
- Reuse of a policy proof for another payment.
- Accidental leakage of wallet keys into prompts, logs, or browser state.

## Required controls

- Keep signing keys outside the LLM and orchestration context.
- Verify ZK proofs inside the signing boundary.
- Bind every proof to payment amount, recipient, resource, and nonce.
- Sign credit requests and lender offers.
- Enforce expirations and deterministic offer validation.
- Use idempotency keys for settlement callbacks and repayment.
- Store only hashes or non-sensitive references on HCS.
- Apply strict per-mission and per-session spending caps.
- Use low-balance disposable testnet accounts for development.

## Threats not solved by the MVP

- Compromise of the restricted signer host.
- A malicious provider already present in the approved allowlist.
- Sybil manipulation of an unprotected reputation system.
- Incorrect or malicious mission-completion callbacks.
- Credit defaults when a mission fails or produces no revenue.
- Bugs or outages in external services, facilitators, wallets, or network infrastructure.

## Boundary of the guarantee

Koven must never claim that ZK alone makes the entire agent secure. The guarantee is narrower: **when the signer and circuit are implemented correctly, the signer cannot authorize a payment that violates the encoded amount and recipient rules.** Everything upstream of that boundary (mission planning, provider selection, credit negotiation) remains probabilistic agent behavior and is not covered by this guarantee.