const TINYBAR_PER_HBAR = 100_000_000n;

/** Formats decimal tinybar without converting through a lossy JS number. */
export function formatTinybar(value: string | bigint): string {
  const tinybar = typeof value === "bigint" ? value : BigInt(value);
  const sign = tinybar < 0n ? "−" : "";
  const absolute = tinybar < 0n ? -tinybar : tinybar;
  const whole = absolute / TINYBAR_PER_HBAR;
  const fraction = (absolute % TINYBAR_PER_HBAR).toString().padStart(8, "0").replace(/0+$/, "");
  return `${sign}${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""} ℏ`;
}

export function compactHash(value: string, head = 8, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(value));
}

export function hashscanTransactionUrl(transactionId: string): string {
  return `https://hashscan.io/testnet/transaction/${encodeURIComponent(transactionId)}`;
}

