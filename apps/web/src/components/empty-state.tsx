import type { ReactNode } from "react";

export function EmptyState({ code, title, description, children }: {
  code: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <section className="empty-state">
      <span className="empty-code">{code}</span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
        {children}
      </div>
    </section>
  );
}

