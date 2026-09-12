import { PrivateKey } from "@koven/hedera";
import type { HttpRequest } from "@koven/schemas";
import { type FieldHasher, loadPoseidon } from "@koven/x402";

import { SignerStore } from "../src/store.js";

export const consumerAccountId = "0.0.1001";
export const providerAccountId = "0.0.2001";
export const feePayerAccountId = "0.0.3001";
export const lenderAccountId = "0.0.4001";
export const providerEndpoint = "http://127.0.0.1:4401";
export const scanUrl = `${providerEndpoint}/scan`;
export const targetSha256 = "1".repeat(64);
export const priceTinybar = "1000000";
export const consumerKey = PrivateKey.generateECDSA();
export const lenderKey = PrivateKey.generateECDSA();
export const providerCallbackSecret = Buffer.alloc(32, 5);
export const credentials = {
  consumer: "c".repeat(43),
  orchestrator: "o".repeat(43),
  registrar: "r".repeat(43),
  lenders: { ["l".repeat(43)]: lenderAccountId },
} as const;
export const lenderCredential = "l".repeat(43);

export const policy = (missionId = "mission-1", overrides: Partial<HttpRequest<"registerMissionPolicy">> = {}): HttpRequest<"registerMissionPolicy"> => ({
  missionId,
  borrowerAccountId: consumerAccountId,
  spendingCapTinybar: "5000000",
  sessionId: "session-1",
  sessionCapTinybar: "8000000",
  targetSha256,
  provider: {
    id: "provider-a",
    accountId: providerAccountId,
    endpoint: providerEndpoint,
    capability: "solidity-scan",
    priceTinybar,
    reputationScore: 0.9,
    expectedLatencyMs: 50,
  },
  approvedRecipientsRoot: "1",
  ...overrides,
});

export const requirements = (overrides: Partial<HttpRequest<"authorize">["requirements"]> = {}): HttpRequest<"authorize">["requirements"] => ({
  scheme: "exact",
  network: "hedera:testnet",
  asset: "0.0.0",
  amount: priceTinybar,
  payTo: providerAccountId,
  maxTimeoutSeconds: 180,
  extra: { feePayer: feePayerAccountId },
  ...overrides,
});

let poseidon: FieldHasher | undefined;
export async function poseidonHasher(): Promise<FieldHasher> {
  poseidon ??= await loadPoseidon();
  return poseidon;
}

export function memoryStore(): SignerStore {
  return new SignerStore(":memory:");
}
