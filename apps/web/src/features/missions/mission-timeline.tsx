import type { HttpResponse } from "@koven/schemas";

import { compactHash, formatDate, hashscanTransactionUrl } from "../../lib/format";
import { humanize } from "../../lib/mission";

type MissionEvent = HttpResponse<"missionDetail">["events"][number];

export function MissionTimeline({ events }: { events: readonly MissionEvent[] }) {
  if (events.length === 0) return <p className="muted">No lifecycle events have been recorded yet.</p>;
  return (
    <ol className="timeline">
      {events.map((event, index) => (
        <li key={event.id}>
          <span className="timeline-index">{String(index + 1).padStart(2, "0")}</span>
          <div className="timeline-line" aria-hidden="true" />
          <div className="timeline-content">
            <div className="card-row">
              <strong>{humanize(event.type)}</strong>
              <time dateTime={event.occurredAt}>{formatDate(event.occurredAt)}</time>
            </div>
            <span className="mono muted">proof · {compactHash(event.payloadHash)}</span>
            {event.transactionId && (
              <a href={hashscanTransactionUrl(event.transactionId)} target="_blank" rel="noreferrer">
                View transaction ↗
              </a>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

