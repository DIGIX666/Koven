"use client";

import { useCallback } from "react";
import type { HttpResponse } from "@koven/schemas";

import { DataList } from "../../components/data-list";
import { EmptyState } from "../../components/empty-state";
import { ErrorState } from "../../components/error-state";
import { StatusPill } from "../../components/status-pill";
import { DashboardApi } from "../../lib/api";
import { POLL_INTERVAL_MS } from "../../lib/config";
import { compactHash, formatDate, formatTinybar, hashscanTransactionUrl } from "../../lib/format";
import {
  derivePaymentEvidence,
  PAYMENT_ASSET,
  PAYMENT_NETWORK,
  type PaymentEvidenceView,
  type PaymentStatus,
  type ProofStatus,
} from "../../lib/payment";
import { usePollingResource } from "../../lib/polling";

export interface PaymentSnapshot {
  mission: HttpResponse<"missionDetail">;
  health?: HttpResponse<"health">;
}

const STATUS: Record<PaymentStatus, { label: string; tone: "neutral" | "active" | "success" | "warning" | "danger" }> = {
  pending: { label: "Pending", tone: "active" },
  authorized: { label: "Authorized · awaiting settlement", tone: "warning" },
  settled: { label: "Settled", tone: "success" },
  rejected: { label: "Rejected by policy", tone: "danger" },
  failed: { label: "Failed before payment", tone: "danger" },
};

const PROOF: Record<ProofStatus, { label: string; tone: "neutral" | "active" | "success" | "warning" | "danger"; decision: string }> = {
  deterministic: { label: "Deterministic gate", tone: "neutral", decision: "M2 policy check without a proof" },
  "not-generated": { label: "Not generated", tone: "active", decision: "No proof yet" },
  generated: { label: "Generated", tone: "active", decision: "Awaiting the signer's verification" },
  verified: { label: "Verified", tone: "success", decision: "Payment authorized" },
  rejected: { label: "Rejected", tone: "danger", decision: "Payment refused" },
};

/** Presentational: everything shown comes from validated read models; no signed bytes ever reach this view. */
export function PaymentEvidencePanel({ evidence }: { evidence: PaymentEvidenceView }) {
  const status = STATUS[evidence.status];
  const proof = PROOF[evidence.proof];
  return (
    <div className="split-grid">
      <section className="panel">
        <div className="card-row">
          <div className="section-heading"><span className="eyebrow">x402 exact</span><h2>Payment intent</h2></div>
          <StatusPill tone={status.tone}>{status.label}</StatusPill>
        </div>
        <DataList items={[
          { label: "Network", value: PAYMENT_NETWORK },
          { label: "Asset", value: `HBAR · ${PAYMENT_ASSET}` },
          { label: "Spending cap", value: formatTinybar(evidence.capTinybar) },
          { label: "Mission", value: <span className="mono">{evidence.missionId}</span> },
          { label: "Resource binding", value: <span className="mono">source · {compactHash(evidence.targetSha256, 12, 10)}</span> },
          { label: "Approved recipient root", value: <span className="mono">{compactHash(evidence.approvedRecipientsRoot, 12, 10)}</span> },
          { label: "Authorized", value: evidence.authorizedAt ? formatDate(evidence.authorizedAt) : "—" },
          { label: "Settled", value: evidence.settledAt ? formatDate(evidence.settledAt) : "—" },
          { label: "Payment transaction", value: evidence.transactionId ? <span className="mono">{evidence.transactionId}</span> : "—" },
        ]} />
        {evidence.transactionId && (
          <a className="evidence-link" href={hashscanTransactionUrl(evidence.transactionId)} target="_blank" rel="noreferrer">
            {evidence.status === "settled" ? "Verify settlement on HashScan ↗" : "Follow the authorized transaction on HashScan ↗"}
          </a>
        )}
      </section>
      <section className="panel">
        <div className="card-row">
          <div className="section-heading"><span className="eyebrow">Groth16</span><h2>Policy proof</h2></div>
          <StatusPill tone={proof.tone}>{proof.label}</StatusPill>
        </div>
        <DataList items={[
          { label: "Circuit", value: evidence.circuitId },
          {
            label: "Pinned vkey SHA-256",
            value: evidence.vkeyHash === null
              ? "No key pinned (deterministic mode)"
              : <span className="mono" title={evidence.vkeyHash}>{compactHash(evidence.vkeyHash, 12, 10)}</span>,
          },
          { label: "Proof generated", value: evidence.proofGeneratedAt ? formatDate(evidence.proofGeneratedAt) : "—" },
          { label: "Signer decision", value: proof.decision },
          { label: "Raw transaction", value: "Hidden by design" },
        ]} />
      </section>
    </div>
  );
}

/** Live payment rail of one mission: mission detail plus the signer's pinned key, polled together. */
export function PaymentWorkspace({ missionId, initialData }: { missionId?: string; initialData?: PaymentSnapshot }) {
  if (!missionId) {
    return (
      <EmptyState
        code="PAY"
        title="Select a mission with payment evidence"
        description="Open a mission to see the decoded x402 intent, the pinned verification key and the Hedera settlement, without exposing signed transaction bytes."
      />
    );
  }
  return <LivePaymentRail missionId={missionId} {...(initialData ? { initialData } : {})} />;
}

function LivePaymentRail({ missionId, initialData }: { missionId: string; initialData?: PaymentSnapshot }) {
  const load = useCallback(async (signal: AbortSignal): Promise<PaymentSnapshot> => {
    const api = new DashboardApi();
    const [mission, health] = await Promise.all([
      api.mission(missionId, signal),
      // The signer being unreachable must not hide the mission's own evidence.
      api.signerHealth(signal).catch(() => undefined),
    ]);
    return health === undefined ? { mission } : { mission, health };
  }, [missionId]);
  const state = usePollingResource(load, initialData, POLL_INTERVAL_MS);

  if (!state.data) {
    return state.error
      ? <ErrorState message={state.error} />
      : <div className="loading-panel" role="status">Loading payment evidence…</div>;
  }
  return (
    <div className="stack-lg">
      {state.error && <ErrorState message={`${state.error}. Showing the last valid response.`} />}
      <div className="card-row">
        <span className="mono muted">{state.data.mission.id}</span>
        <span className="refresh-state">{state.refreshing ? "Refreshing…" : "Live"}</span>
      </div>
      <PaymentEvidencePanel evidence={derivePaymentEvidence(state.data.mission, state.data.health)} />
    </div>
  );
}
