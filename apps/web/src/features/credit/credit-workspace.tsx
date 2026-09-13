import { EmptyState } from "../../components/empty-state";
import { DataList } from "../../components/data-list";
import { StatusPill } from "../../components/status-pill";
import { formatDate, formatTinybar } from "../../lib/format";

export interface CreditOfferView {
  id: string;
  lenderAccountId: string;
  principalTinybar: string;
  feeTinybar: string;
  termSeconds: number;
  expiresAt: string;
  score: number;
  selected: boolean;
  breakdown: Readonly<Record<string, number>>;
}

export function CreditWorkspace({ offers = [] }: { offers?: readonly CreditOfferView[] }) {
  if (offers.length === 0) {
    return (
      <EmptyState
        code="F11"
        title="Waiting for competing offers"
        description="The credit workspace is ready. It will compare lender terms and explain the deterministic winner as soon as F11 exposes the read model."
      >
        {/* F11 integration: replace only this empty state with validated offer
            data. Add the read schema through the contract-change protocol; do
            not infer offer scores from audit hashes or duplicate B4.1 here. */}
      </EmptyState>
    );
  }

  return (
    <div className="offer-grid">
      {offers.map(offer => (
        <article className={`panel offer-card ${offer.selected ? "offer-selected" : ""}`} key={offer.id}>
          <div className="card-row">
            <div><span className="eyebrow">Lender offer</span><h2>{offer.lenderAccountId}</h2></div>
            {offer.selected && <StatusPill tone="success">Selected</StatusPill>}
          </div>
          <strong className="offer-score">{offer.score.toFixed(3)} <small>score</small></strong>
          <DataList items={[
            { label: "Principal", value: formatTinybar(offer.principalTinybar) },
            { label: "Fee", value: formatTinybar(offer.feeTinybar) },
            { label: "Total repayment", value: formatTinybar(BigInt(offer.principalTinybar) + BigInt(offer.feeTinybar)) },
            { label: "Term", value: `${offer.termSeconds}s` },
            { label: "Expires", value: formatDate(offer.expiresAt) },
          ]} />
          <div className="score-breakdown">
            {Object.entries(offer.breakdown).map(([key, value]) => (
              <div key={key}><span>{key}</span><div><i style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} /></div><strong>{value.toFixed(2)}</strong></div>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}
