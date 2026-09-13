import type { Metadata } from "next";

import { PageHeader } from "../../components/page-header";
import { PaymentWorkspace } from "../../features/payments/payment-workspace";

export const metadata: Metadata = { title: "Payments" };

export default function PaymentsPage() {
  return (
    <div className="page">
      <PageHeader eyebrow="A6.1 · Payment rail" title="Proof and settlement" description="See what the agent proved, what the signer authorized and where the payment settled." />
      <PaymentWorkspace />
    </div>
  );
}

