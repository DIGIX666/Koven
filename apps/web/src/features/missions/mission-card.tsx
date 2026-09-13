import Link from "next/link";
import type { HttpResponse } from "@koven/schemas";

import { StatusPill } from "../../components/status-pill";
import { formatDate, formatTinybar } from "../../lib/format";
import { humanize, missionProgress, missionTone } from "../../lib/mission";

export function MissionCard({ mission }: { mission: HttpResponse<"missionDetail"> }) {
  const progress = missionProgress(mission.state);
  return (
    <Link className="mission-card" href={`/missions/${encodeURIComponent(mission.id)}`}>
      <div className="card-row">
        <span className="mono muted">{mission.id}</span>
        <StatusPill tone={missionTone(mission.state)}>{humanize(mission.state)}</StatusPill>
      </div>
      <h2>{mission.targetRef}</h2>
      <div className="progress-track" aria-label={`${progress}% mission progress`}>
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="card-row mission-meta">
        <span>{formatTinybar(mission.spentTinybar)} spent</span>
        <span>{formatTinybar(mission.spendingCapTinybar)} cap</span>
        <span>{formatDate(mission.updatedAt)}</span>
      </div>
    </Link>
  );
}

