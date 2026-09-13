import { EmptyState } from "../../components/empty-state";
import { DataList } from "../../components/data-list";
import { StatusPill } from "../../components/status-pill";
import { compactHash, formatTinybar, hashscanTransactionUrl } from "../../lib/format";

export interface PaymentEvidenceView {
  transactionId: string;
  amountTinybar: string;
  recipient: string;
  circuitId: string;
  vkeyHash: string;
  verified: boolean;
}

export function PaymentWorkspace({ evidence }: { evidence?: PaymentEvidenceView }) {
  if (!evidence) {
    return (
      <EmptyState
        code="PAY"
        title="Select a mission with payment evidence"
        description="The payment rail will show the decoded x402 challenge, pinned verification key and Hedera settlement without exposing signed transaction bytes."
      >
        {/* F11 integration: the selected provider should arrive through the
            mission read model. Never hardcode a provider id or recompute the
            winner in this Track A view. */}
      </EmptyState>
    );
  }
  return (
    <div className="split-grid">
      <section className="panel">
        <div className="card-row">
          <div className="section-heading"><span className="eyebrow">x402 exact</span><h2>Payment intent</h2></div>
          <StatusPill tone="success">Settled</StatusPill>
        </div>
        <DataList items={[
          { label: "Network", value: "hedera:testnet" },
          { label: "Asset", value: "HBAR · 0.0.0" },
          { label: "Amount", value: formatTinybar(evidence.amountTinybar) },
          { label: "Recipient", value: <span className="mono">{evidence.recipient}</span> },
        ]} />
        <a className="evidence-link" href={hashscanTransactionUrl(evidence.transactionId)} target="_blank" rel="noreferrer">
          Verify settlement on HashScan ↗
        </a>
      </section>
      <section className="panel">
        <div className="card-row">
          <div className="section-heading"><span className="eyebrow">Groth16</span><h2>Policy proof</h2></div>
          <StatusPill tone={evidence.verified ? "success" : "danger"}>{evidence.verified ? "Verified" : "Rejected"}</StatusPill>
        </div>
        <DataList items={[
          { label: "Circuit", value: evidence.circuitId },
          { label: "Pinned vkey SHA-256", value: <span className="mono">{compactHash(evidence.vkeyHash, 12, 10)}</span> },
          { label: "Signer decision", value: evidence.verified ? "Payment authorized" : "Payment refused" },
          { label: "Raw transaction", value: "Hidden by design" },
        ]} />
      </section>
    </div>
  );
}
