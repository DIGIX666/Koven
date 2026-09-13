export const POLL_INTERVAL_MS = 2_000;

export function configuredMissionIds(value = process.env.NEXT_PUBLIC_DEMO_MISSION_IDS): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").map(id => id.trim()).filter(Boolean))]
    .filter(id => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id));
}

export const providerQuery = {
  capability: process.env.NEXT_PUBLIC_PROVIDER_CAPABILITY?.trim() || "solidity-security",
  maxPriceTinybar: process.env.NEXT_PUBLIC_MAX_PRICE_TINYBAR?.trim() || "2500000000",
};

