"use client";

import { useCallback } from "react";
import type { HttpResponse } from "@koven/schemas";

import { EmptyState } from "../../components/empty-state";
import { ErrorState } from "../../components/error-state";
import { StatusPill } from "../../components/status-pill";
import { DashboardApi } from "../../lib/api";
import { POLL_INTERVAL_MS, providerQuery } from "../../lib/config";
import { formatTinybar } from "../../lib/format";
import { usePollingResource } from "../../lib/polling";

function scoreWidth(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export function ProviderRanking({ initialData }: { initialData?: HttpResponse<"rankProviders"> }) {
  const load = useCallback(
    (signal: AbortSignal) => new DashboardApi().rankedProviders(providerQuery, signal),
    [],
  );
  const state = usePollingResource(load, initialData, POLL_INTERVAL_MS);

  if (!state.data && state.error) return <ErrorState message={state.error} />;
  if (!state.data) return <div className="loading-panel" role="status">Loading provider ranking…</div>;
  if (state.data.ranked.length === 0) {
    return <EmptyState code="00" title="No eligible provider" description="No provider matches the configured capability and price ceiling." />;
  }

  return (
    <div className="stack-lg">
      {state.error && <ErrorState message={`${state.error}. Showing the last valid ranking.`} />}
      <div className="formula-bar">
        <span>Ranking formula</span>
        <code>{state.data.formula}</code>
      </div>
      <div className="ranking-list">
        {state.data.ranked.map((entry, index) => (
          <article className={`provider-card ${index === 0 ? "provider-winner" : ""}`} key={entry.provider.id}>
            <span className="rank-number">{String(index + 1).padStart(2, "0")}</span>
            <div className="provider-main">
              <div className="card-row">
                <div><span className="eyebrow">{entry.provider.capability}</span><h2>{entry.provider.id}</h2></div>
                {index === 0 && <StatusPill tone="success">Selected</StatusPill>}
              </div>
              <div className="provider-facts">
                <span><small>Price</small><strong>{formatTinybar(entry.provider.priceTinybar)}</strong></span>
                <span><small>Latency</small><strong>{entry.provider.expectedLatencyMs.toLocaleString("en-US")} ms</strong></span>
                <span><small>Reputation</small><strong>{Math.round(entry.provider.reputationScore * 100)}%</strong></span>
                <span><small>Total score</small><strong>{entry.score.toFixed(3)}</strong></span>
              </div>
              <div className="score-breakdown">
                {Object.entries(entry.breakdown).map(([key, value]) => (
                  <div key={key}><span>{key}</span><div><i style={{ width: scoreWidth(value) }} /></div><strong>{value.toFixed(2)}</strong></div>
                ))}
              </div>
            </div>
          </article>
        ))}
      </div>
      {/* F11 integration: keep this component bound to ProviderRankResponseSchema;
          Kazai only needs to expose the final ranking endpoint, never duplicate
          the ranking formula or provider identities in the dashboard. */}
    </div>
  );
}

