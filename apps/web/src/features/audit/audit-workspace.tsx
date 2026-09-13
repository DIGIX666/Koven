import { EmptyState } from "../../components/empty-state";
import { StatusPill } from "../../components/status-pill";
import { compactHash, formatDate, hashscanTransactionUrl } from "../../lib/format";

export interface HcsAuditView {
  eventId: string;
  sequenceNumber: string;
  payloadHash: string;
  transactionId: string;
  publishedAt: string;
}

export function AuditWorkspace({ events = [] }: { events?: readonly HcsAuditView[] }) {
  if (events.length === 0) {
    return (
      <EmptyState
        code="F12"
        title="HCS evidence is not published yet"
        description="Local lifecycle evidence remains available on each mission. This view will activate when F12 exposes durable HCS publication records."
      >
        {/* F12 integration: replace this empty state only after the audit read
            contract exposes eventId, sequenceNumber, payloadHash, transactionId
            and publishedAt. Render public envelopes; never fetch payload_json. */}
      </EmptyState>
    );
  }
  return (
    <ol className="audit-list">
      {events.map((event, index) => (
        <li className="panel" key={event.eventId}>
          <div className="card-row">
            <span className="rank-number">{String(index + 1).padStart(2, "0")}</span>
            <StatusPill tone="success">Consensus #{event.sequenceNumber}</StatusPill>
          </div>
          <h2>{event.eventId}</h2>
          <span className="mono muted">payload · {compactHash(event.payloadHash, 12, 10)}</span>
          <div className="card-row audit-footer">
            <time dateTime={event.publishedAt}>{formatDate(event.publishedAt)}</time>
            <a href={hashscanTransactionUrl(event.transactionId)} target="_blank" rel="noreferrer">Public evidence ↗</a>
          </div>
        </li>
      ))}
    </ol>
  );
}
