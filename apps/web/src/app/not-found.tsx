import Link from "next/link";

import { EmptyState } from "../components/empty-state";

export default function NotFound() {
  return (
    <div className="page narrow-page">
      <EmptyState code="404" title="Evidence not found" description="The requested dashboard view does not exist.">
        <Link className="secondary-action" href="/">Return to mission control</Link>
      </EmptyState>
    </div>
  );
}

