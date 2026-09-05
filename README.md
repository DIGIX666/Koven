# Koven

> Credit and policy infrastructure for autonomous x402 agents on Hedera.

## What is Koven

Koven lets an AI agent discover paid x402 services, borrow working capital from competing lender agents when it can't afford a mission upfront, pay through x402 on Hedera, and repay its lender once the mission generates revenue — while a zero-knowledge proof, verified inside an isolated signer, enforces the mission's spending cap and approved-recipient policy at the signing boundary. The goal is to give agents real financial autonomy without ever giving an LLM direct control over a wallet.

## Why

x402 solves payment access, not the operational problems around it:

- **Liquidity** — an agent may have a profitable mission but no funds to pay for it upfront.
- **Procurement** — an agent needs to compare providers on price, reputation, and reliability.
- **Wallet safety** — a compromised prompt must never be able to redirect funds or exceed a budget.

Koven adds a credit and policy layer on top of x402 to address all three. Full rationale and failure-mode analysis: [`docs/threat-model.md`](./docs/threat-model.md).

## How it works

```mermaid
flowchart LR
    U[User or Client] -->|Creates mission and budget| O[Consumer Agent]
    O -->|Discovers services| D[Service Directory]
    D --> P1[x402 Provider A]
    D --> P2[x402 Provider B]

    O -->|Balance insufficient| C[Credit Marketplace]
    C --> L1[Lender Agent A]
    C --> L2[Lender Agent B]
    L1 -->|Loan quote| C
    L2 -->|Loan quote| C
    C -->|Best valid quote| O

    O -->|Create policy proof| Z[ZK Policy Prover]
    Z -->|Proof and commitment| W[Policy-Enforced Signer]
    W -->|Signed x402 payment| P2
    P2 -->|Settle| B[Blocky402]
    B -->|Transfer| H[Hedera Network]
    P2 -->|Paid result| O

    O -->|Mission output| U
    U -->|Revenue| R[Repayment Engine]
    R -->|Principal and fee| L1
```

Full protocol flow, state machine, and ZK proof statement: [`docs/protocol.md`](./docs/protocol.md).

## Local development

### Prerequisites

- Node.js 20 or later
- pnpm, available directly or through Corepack

### Setup

```bash
git clone https://github.com/DIGIX666/Koven.git
cd Koven
corepack enable
pnpm install
cp .env.example .env
```

The default environment targets Hedera testnet. Add the required disposable
testnet account credentials to `.env`; never commit that file or use mainnet
credentials for local development.

### Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run every workspace that currently exposes a `dev` script |
| `pnpm build` | Build every workspace that currently exposes a `build` script |
| `pnpm lint` | Lint every workspace that currently exposes a `lint` script |
| `pnpm typecheck` | Type-check every workspace that currently exposes a `typecheck` script |
| `pnpm test` | Test every workspace that currently exposes a `test` script |
| `pnpm test:e2e` | Run the end-to-end workspace once its test runner is implemented |
| `pnpm zk:build` | Compile the ZK policy circuit once its build script is implemented |
| `pnpm zk:test` | Test proof generation and verification once its test script is implemented |

The repository is currently at the scaffold stage. Workspace-specific runtime,
build, and test scripts will be added with their implementations, so aggregate
commands may complete without starting a service or running a test yet.

## Documentation

| File | Content |
| --- | --- |
| [`docs/architecture.md`](./docs/architecture.md) | System architecture diagram, core components |
| [`docs/protocol.md`](./docs/protocol.md) | End-to-end protocol flow, mission/loan lifecycle, ZK policy proof |
| [`docs/threat-model.md`](./docs/threat-model.md) | Failure modes, threats addressed and not addressed, required controls |
| [`docs/success-criteria.md`](./docs/success-criteria.md) | Definition of done for the MVP |

## Planned repository structure

```text
Koven/
├── apps/            # Dashboard and mission/credit/payment orchestrator
├── agents/          # Consumer (borrower) agent and lender agents
├── services/        # x402 resource server, directory, callback handler
├── packages/        # credit-protocol, hedera, x402, policy, zk-policy, identity, shared
├── tests/           # unit, integration, e2e
├── docs/
└── README.md
```

This layout is planned and may evolve during implementation.

## Hedera & protocol integrations

| Technology | Planned use |
| --- | --- |
| Hedera / HBAR | Settlement, funding, and repayment asset |
| HCS | Audit trail for credit, payment, and repayment events |
| Hedera Agent Kit | Balance queries, transfers, HCS actions |
| x402 v2 | HTTP-native payment negotiation |
| Blocky402 | Required facilitator for Hedera payment settlement |
| Circom / SnarkJS | Candidate stack for the policy circuit |

## References

- [ETHOnline 2026 — Hedera prizes](https://ethglobal.com/events/ethonline2026/prizes#hedera)
- [Hedera developer documentation](https://docs.hedera.com/)
- [Hedera Agent Kit](https://github.com/hashgraph/hedera-agent-kit-js)
- [Hedera x402 inference reference](https://github.com/hedera-dev/x402-inference-pay-per-request-poc)
- [Blocky402 facilitator](https://blocky402.com/)
- [x402 protocol](https://github.com/x402-foundation/x402)
- [ERC-8004: Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004)
- [HCS-14: Universal Agent ID](https://github.com/hiero-ledger/hiero-consensus-specifications/tree/main/docs/standards/hcs-14)

## Team

- [Theo Dubois](https://linkedin.com/in/th%c3%a9o-dubois-662407194)
- [Zakaria Chaikhi](https://www.linkedin.com/in/zakaria-chaikhi-55907b2a0/)

## License

`Koven` is released under the [Apache License 2.0](./LICENSE). See [NOTICE](./NOTICE) for attribution information.
