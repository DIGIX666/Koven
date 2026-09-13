export function ErrorState({ message }: { message: string }) {
  return (
    <div className="error-state" role="alert">
      <strong>Live data unavailable</strong>
      <span>{message}</span>
    </div>
  );
}

