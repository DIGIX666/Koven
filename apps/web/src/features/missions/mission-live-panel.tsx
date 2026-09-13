"use client";

import { useCallback } from "react";
import type { HttpResponse } from "@koven/schemas";

import { DataList } from "../../components/data-list";
import { ErrorState } from "../../components/error-state";
import { StatusPill } from "../../components/status-pill";
import { DashboardApi } from "../../lib/api";
import { POLL_INTERVAL_MS } from "../../lib/config";
import { compactHash, formatDate, formatTinybar } from "../../lib/format";
import { humanize, missionProgress, missionTone } from "../../lib/mission";
import { usePollingResource } from "../../lib/polling";
import { MissionTimeline } from "./mission-timeline";

export function MissionLivePanel({ missionId, initialData }: {
  missionId: string;
  initialData?: HttpResponse<"missionDetail">;
}) {
  const load = useCallback((signal: AbortSignal) => new DashboardApi().mission(missionId, signal), [missionId]);
  const state = usePollingResource(load, initialData, POLL_INTERVAL_MS);
  const mission = state.data;

  if (!mission) {
    return state.error
      ? <ErrorState message={state.error} />
      : <div className="loading-panel" role="status">Loading mission evidence…</div>;
  }

  const progress = missionProgress(mission.state);
  return (
    <div className="stack-lg">
      {state.error && <ErrorState message={`${state.error}. Showing the last valid response.`} />}
      <section className="panel mission-hero">
        <div className="card-row">
          <StatusPill tone={missionTone(mission.state)}>{humanize(mission.state)}</StatusPill>
          <span className="refresh-state">{state.refreshing ? "Refreshing…" : "Live"}</span>
        </div>
        <h2>{mission.targetRef}</h2>
        <span className="mono muted">{mission.id}</span>
        <div className="progress-track progress-large" aria-label={`${progress}% mission progress`}>
          <span style={{ width: `${progress}%` }} />
        </div>
        <div className="progress-caption"><span>Lifecycle progress</span><strong>{progress}%</strong></div>
      </section>

      <section className="split-grid">
        <article className="panel">
          <div className="section-heading"><span className="eyebrow">Policy</span><h2>Mission guardrails</h2></div>
          <DataList items={[
            { label: "Budget cap", value: formatTinybar(mission.spendingCapTinybar) },
            { label: "Spent", value: formatTinybar(mission.spentTinybar) },
            { label: "Source SHA-256", value: <span className="mono">{compactHash(mission.targetSha256)}</span> },
            { label: "Recipient root", value: <span className="mono">{compactHash(mission.approvedRecipientsRoot)}</span> },
            { label: "Last update", value: formatDate(mission.updatedAt) },
          ]} />
        </article>
        <article className="panel">
          <div className="section-heading"><span className="eyebrow">Audit</span><h2>Lifecycle timeline</h2></div>
          <MissionTimeline events={mission.events} />
        </article>
      </section>
    </div>
  );
}

