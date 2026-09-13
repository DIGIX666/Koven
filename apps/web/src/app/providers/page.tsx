import type { Metadata } from "next";

import { PageHeader } from "../../components/page-header";
import { ProviderRanking } from "../../features/providers/provider-ranking";

export const metadata: Metadata = { title: "Providers" };

export default function ProvidersPage() {
  return (
    <div className="page">
      <PageHeader eyebrow="B6.1 · Service market" title="Provider ranking" description="A deterministic view of price, latency and reputation derived from mission events." />
      <ProviderRanking />
    </div>
  );
}

