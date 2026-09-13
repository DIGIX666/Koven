import type { Metadata } from "next";

import { PageHeader } from "../../components/page-header";
import { CreditWorkspace } from "../../features/credit/credit-workspace";

export const metadata: Metadata = { title: "Credit" };

export default function CreditPage() {
  return (
    <div className="page">
      <PageHeader eyebrow="B6.1 · Agent credit" title="Competing lender offers" description="Compare complete terms, score breakdowns and the deterministic policy decision." />
      <CreditWorkspace />
    </div>
  );
}

