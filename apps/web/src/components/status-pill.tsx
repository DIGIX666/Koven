import type { ReactNode } from "react";

export function StatusPill({ tone = "neutral", children }: {
  tone?: "neutral" | "active" | "success" | "warning" | "danger";
  children: ReactNode;
}) {
  return <span className={`status-pill status-${tone}`}>{children}</span>;
}

