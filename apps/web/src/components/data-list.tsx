import type { ReactNode } from "react";

export function DataList({ items }: { items: ReadonlyArray<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="data-list">
      {items.map(item => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

