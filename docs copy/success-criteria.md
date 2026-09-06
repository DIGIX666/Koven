# Success criteria

The MVP is complete when all of the following are true:

- A public x402 endpoint returns a real paid resource.
- Blocky402 settles at least one payment on Hedera testnet.
- The consumer agent selects a provider without a hardcoded final choice.
- Two lender agents generate valid, distinguishable offers.
- A lender funds the consumer agent on Hedera testnet.
- A valid ZK proof unlocks signing for an approved payment.
- Invalid amount and recipient proofs are rejected in tests.
- Proof reuse with a different nonce, resource, amount, or recipient is rejected in tests.
- The mission result reaches the user or calling client.
- A callback triggers an on-chain repayment.
- Replayed callbacks cannot trigger a second repayment.
- The dashboard shows every critical lifecycle step.
- The repository contains reproducible setup and architecture documentation.
- The full demo fits within five minutes.