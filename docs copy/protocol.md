# Protocol

## End-to-end flow

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Agent as Consumer Agent
    participant Directory as Service Directory
    participant LenderA as Lender Agent A
    participant LenderB as Lender Agent B
    participant Prover as ZK Prover
    participant Signer as Restricted Signer
    participant Service as x402 Resource Server
    participant Blocky as Blocky402
    participant Hedera
    participant Audit as HCS Audit Topic

    User->>Agent: Submit mission and maximum budget
    Agent->>Directory: Discover compatible services
    Directory-->>Agent: Providers, prices, reputation, latency
    Agent->>Agent: Rank providers and estimate required funds

    alt Agent balance is insufficient
        Agent->>LenderA: Signed credit request
        Agent->>LenderB: Signed credit request
        LenderA-->>Agent: Signed loan offer A
        LenderB-->>Agent: Signed loan offer B
        Agent->>Agent: Validate and select best offer
        Agent->>LenderA: Accept offer
        LenderA->>Hedera: Transfer working capital
        Hedera-->>Agent: Funding receipt
        Agent->>Audit: Record credit request and accepted offer
    end

    Agent->>Service: Request resource without payment
    Service-->>Agent: HTTP 402 plus payment requirements
    Agent->>Prover: Amount, recipient, challenge, policy witness
    Prover-->>Signer: Proof plus payment commitment
    Signer->>Signer: Verify proof and exact challenge binding
    Signer-->>Agent: Signed x402 payment payload
    Agent->>Service: Retry with payment signature
    Service->>Blocky: Verify and settle payment
    Blocky->>Hedera: Submit Hedera transaction
    Hedera-->>Blocky: Consensus receipt
    Blocky-->>Service: Settlement response
    Service-->>Agent: Paid result plus settlement reference
    Agent->>Audit: Record proof and payment receipt hashes

    Agent-->>User: Deliver mission result
    User->>Agent: Revenue or completion payment
    Agent->>Hedera: Repay principal plus lender fee
    Hedera-->>Agent: Repayment receipt
    Agent->>Audit: Record mission completion and repayment
```

## Mission and loan lifecycle

```mermaid
stateDiagram-v2
    [*] --> MissionCreated
    MissionCreated --> DiscoveringServices
    DiscoveringServices --> BudgetCheck

    BudgetCheck --> PaymentPreparation: Balance sufficient
    BudgetCheck --> CreditRequested: Balance insufficient

    CreditRequested --> OffersReceived
    OffersReceived --> LoanAccepted: Valid competitive offer selected
    OffersReceived --> MissionRejected: No acceptable offer
    LoanAccepted --> Funded: Funding confirmed on Hedera
    Funded --> PaymentPreparation

    PaymentPreparation --> ProofGenerated
    ProofGenerated --> PaymentAuthorized: Proof valid
    ProofGenerated --> PolicyRejected: Proof invalid
    PaymentAuthorized --> ServicePaid: x402 settlement confirmed
    ServicePaid --> MissionRunning
    MissionRunning --> MissionCompleted
    MissionRunning --> MissionFailed

    MissionCompleted --> RepaymentPending: Active loan
    MissionCompleted --> Closed: No loan
    RepaymentPending --> Repaid
    Repaid --> Closed

    MissionFailed --> Recovery
    PolicyRejected --> Recovery
    Recovery --> RepaymentPending: Recoverable funds or revenue
    Recovery --> Defaulted: Repayment unavailable

    MissionRejected --> [*]
    Defaulted --> [*]
    Closed --> [*]
```

## ZK spending guardrails

The ZK component is a wallet-safety feature, not a standalone product. Its purpose is to ensure that a compromised prompt cannot convince the signer to violate an approved payment policy.

### Policy rules for the MVP

For every payment, the prover demonstrates:

1. `paymentAmount <= missionSpendingCap`
2. `paymentRecipient` is included in the approved recipient Merkle tree

The proof must also be bound to the exact x402 challenge so that a valid proof cannot be reused for another amount, recipient, resource, or nonce.

### Proposed proof statement

```text
Given:
  paymentAmount
  paymentRecipient
  paymentNonce
  resourceHash
  missionSpendingCap
  approvedRecipientsRoot
  recipientMerklePath

Prove that:
  paymentAmount <= missionSpendingCap
  MerkleVerify(
    approvedRecipientsRoot,
    Hash(paymentRecipient),
    recipientMerklePath
  ) == true
  paymentCommitment == Hash(
    paymentAmount,
    paymentRecipient,
    paymentNonce,
    resourceHash
  )
```

### Enforcement flow

```mermaid
flowchart LR
    C[HTTP 402 Challenge] --> N[Normalize Payment Requirements]
    P[Mission Policy] --> W[Build Private Witness]
    N --> W
    W --> Z[Generate ZK Proof]
    Z --> V{Verify Proof}
    N --> B{Commitment matches exact payment?}
    V -->|Invalid| X[Reject and do not sign]
    V -->|Valid| B
    B -->|No| X
    B -->|Yes| S[Restricted signer authorizes payment]
    S --> R[Retry x402 request]
```

The private key is never exposed to the mission-planning model. Only the restricted signer can authorize a Hedera payment, and it accepts a request only after proof verification and challenge binding.