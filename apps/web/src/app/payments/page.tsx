import type { Metadata } from "next";

import { PageHeader } from "../../components/page-header";
import { MissionSearch } from "../../features/missions/mission-search";
import { PaymentWorkspace, type PaymentSnapshot } from "../../features/payments/payment-workspace";
import { dashboardApi } from "../../lib/api";

export const metadata: Metadata = { title: "Payments" };
export const dynamic = "force-dynamic";

const MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<{ mission?: string | string[] }> }) {
  const requested = (await searchParams).mission;
  const missionId = typeof requested === "string" && MISSION_ID.test(requested) ? requested : undefined;
  let initialData: PaymentSnapshot | undefined;
  if (missionId !== undefined) {
    const [mission, health] = await Promise.all([
      dashboardApi.mission(missionId).catch(() => undefined),
      dashboardApi.signerHealth().catch(() => undefined),
    ]);
    if (mission !== undefined) initialData = health === undefined ? { mission } : { mission, health };
  }
  return (
    <div className="page">
      <PageHeader
        eyebrow="A6.1 · Payment rail"
        title="Proof and settlement"
        description="See what the agent proved, what the signer authorized and where the payment settled."
        action={<MissionSearch destination="/payments" />}
      />
      <PaymentWorkspace {...(missionId ? { missionId } : {})} {...(initialData ? { initialData } : {})} />
    </div>
  );
}
