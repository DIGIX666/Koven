export interface Provider {
  id: string;
  accountId: string;
  endpoint: string;
  capability: string;
  priceTinybar: bigint;
  reputationScore: number;
  expectedLatencyMs: number;
}

export interface RankedProvider {
  provider: Provider;
  score: number;
  breakdown: { price: number; reputation: number; latency: number };
}
