import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "../../../components/page-header";
import { MissionLivePanel } from "../../../features/missions/mission-live-panel";
import { dashboardApi } from "../../../lib/api";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  return { title: `Mission ${(await params).id}` };
}

export default async function MissionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const initialData = await dashboardApi.mission(id).catch(() => undefined);
  return (
    <div className="page">
      <PageHeader
        eyebrow="Live mission evidence"
        title="Execution trace"
        description="The view refreshes from the orchestrator every two seconds and preserves the last valid response during an outage."
        action={(
          <span className="card-row">
            <Link className="secondary-action" href={`/payments?mission=${encodeURIComponent(id)}`}>Payment rail →</Link>
            <Link className="secondary-action" href="/missions">← All missions</Link>
          </span>
        )}
      />
      <MissionLivePanel missionId={id} {...(initialData ? { initialData } : {})} />
    </div>
  );
}
