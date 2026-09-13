"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="page narrow-page">
      <div className="error-state" role="alert">
        <strong>The dashboard could not render this view.</strong>
        <span>Live protocol state was not modified.</span>
        <button type="button" onClick={reset}>Try again</button>
      </div>
    </div>
  );
}

