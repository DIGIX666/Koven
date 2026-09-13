import type { Metadata } from "next";

import { PageHeader } from "../../components/page-header";
import { AuditWorkspace } from "../../features/audit/audit-workspace";

export const metadata: Metadata = { title: "Audit" };

export default function AuditPage() {
  return (
    <div className="page">
      <PageHeader eyebrow="A6.1 · Consensus evidence" title="HCS audit trail" description="Match each local lifecycle event to its hash-only public attestation." />
      <AuditWorkspace />
    </div>
  );
}
