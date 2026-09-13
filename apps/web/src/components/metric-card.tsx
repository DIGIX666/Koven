import type { ReactNode } from "react";

export function MetricCard({ label, value, detail, icon }: {
  label: string;
  value: ReactNode;
  detail: string;
  icon: string;
}) {
  return (
    <article className="metric-card">
      <span className="metric-icon" aria-hidden="true">{icon}</span>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

