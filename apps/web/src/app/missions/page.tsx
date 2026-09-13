import type { Metadata } from "next";

import { EmptyState } from "../../components/empty-state";
import { PageHeader } from "../../components/page-header";
import { dashboardApi } from "../../lib/api";
import { configuredMissionIds } from "../../lib/config";
import { MissionCard } from "../../features/missions/mission-card";
import { MissionSearch } from "../../features/missions/mission-search";

export const metadata: Metadata = { title: "Missions" };
export const dynamic = "force-dynamic";

export default async function MissionsPage() {
  // The frozen API currently exposes mission detail but no collection route.
  // Keep the demo list configuration-driven until a reviewed read contract
  // replaces this lookup; never query the orchestrator database from the UI.
  const ids = configuredMissionIds();
  const results = await Promise.allSettled(ids.map(id => dashboardApi.mission(id)));
  const missions = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);

  return (
    <div className="page">
      <PageHeader
        eyebrow="B6.1 · Mission state"
        title="Mission lifecycle"
        description="Inspect the current policy state and every locally attested transition."
        action={<MissionSearch />}
      />
      {missions.length > 0 ? (
        <section className="mission-grid">{missions.map(mission => <MissionCard mission={mission} key={mission.id} />)}</section>
      ) : (
        <EmptyState
          code="M00"
          title="No configured mission"
          description="Paste a mission id above, or set NEXT_PUBLIC_DEMO_MISSION_IDS to preload the demo run."
        />
      )}
    </div>
  );
}
