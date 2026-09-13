import Link from "next/link";

import { MetricCard } from "../components/metric-card";
import { PageHeader } from "../components/page-header";

const features = [
  { href: "/missions", number: "01", title: "Mission lifecycle", text: "Follow policy, execution and repayment state from one timeline." },
  { href: "/credit", number: "02", title: "Agent credit", text: "Compare lender offers and inspect why the policy chose one." },
  { href: "/providers", number: "03", title: "Provider market", text: "Watch price, latency and event-derived reputation shape the ranking." },
  { href: "/payments", number: "04", title: "Proof & settlement", text: "Inspect the x402 intent, ZK result and Hedera transaction evidence." },
  { href: "/audit", number: "05", title: "HCS audit", text: "Link local lifecycle events to their public consensus attestations." },
] as const;

export default function HomePage() {
  return (
    <div className="page">
      <PageHeader
        eyebrow="Koven protocol"
        title="Autonomous payments, with receipts."
        description="One live console for the policy, credit and settlement trail behind every agent mission."
        action={<Link className="primary-action" href="/missions">Open mission control →</Link>}
      />
      <section className="metric-grid" aria-label="Protocol guarantees">
        <MetricCard icon="K" label="Consumer keys" value="0 exposed" detail="Signing stays inside the restricted signer" />
        <MetricCard icon="Z" label="Policy proof" value="Groth16" detail="Verified by signer and lender" />
        <MetricCard icon="H" label="Settlement rail" value="Hedera" detail="External evidence on testnet" />
      </section>
      <section className="feature-grid">
        {features.map(feature => (
          <Link className="feature-card" href={feature.href} key={feature.href}>
            <span>{feature.number}</span>
            <div><h2>{feature.title}</h2><p>{feature.text}</p></div>
            <b aria-hidden="true">↗</b>
          </Link>
        ))}
      </section>
    </div>
  );
}

