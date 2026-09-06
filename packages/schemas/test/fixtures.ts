import type { HttpContractName } from "../src/index.js";
export const hash = "a".repeat(64);
export const signature = "b".repeat(128);
export const time = "2026-09-06T12:00:00.000Z";
export const tx = "0.0.10@1788696000.000000001";
export const provider = { id: "prov-a", accountId: "0.0.20", endpoint: "http://localhost:3003", capability: "solidity-scan", priceTinybar: "100", reputationScore: 0.8, expectedLatencyMs: 100 };
export const mission = { id: "mission-1", state: "created", spendingCapTinybar: "1000", spentTinybar: "0", approvedRecipientsRoot: "1", targetRef: "Example.sol", targetSha256: hash, createdAt: time, updatedAt: time };
export const request = { id: "request-1", missionId: mission.id, borrowerAccountId: "0.0.10", principalTinybar: "100", requestedTermSeconds: 60, purposeHash: hash, createdAt: time };
export const offer = { id: "offer-1", requestId: request.id, lenderAccountId: "0.0.30", principalTinybar: "100", feeTinybar: "1", termSeconds: 60, expiresAt: time, termsHash: hash, signature };
export const acceptance = { requestId: request.id, missionId: mission.id, borrowerAccountId: request.borrowerAccountId, lenderAccountId: offer.lenderAccountId, offerId: offer.id, termsHash: hash, expiresAt: time };
export const scan = { missionId: mission.id, targetRef: mission.targetRef, source: "pragma solidity ^0.8.0; contract Example {}", targetSha256: hash };
export const report = { schemaVersion: 1, missionId: mission.id, targetSha256: hash, providerId: provider.id, findings: [], startedAt: time, completedAt: time, reportSha256: hash };
export const callback = { outcome: { missionId: mission.id, delivered: true, reportSha256: hash, settlementTxId: tx, observedAt: time }, report };
export const intent = { amountTinybar: "100", recipientAccountId: provider.accountId, nonce: "1", resourceHash: hash, missionId: mission.id };
// Structural fixture only: intentionally not a cryptographically valid proof/signature/hash.
export const bundle = { proof: { protocol: "groth16", curve: "bn128", pi_a: ["1", "2", "1"], pi_b: [["1", "2"], ["3", "4"], ["1", "0"]], pi_c: ["1", "2", "1"] }, publicSignals: ["1", "1", "1000"], vkeyHash: hash, circuitId: "koven-policy-v1" };
export const requirements = { scheme: "exact", network: "hedera:testnet", asset: "0.0.0", amount: "100", payTo: provider.accountId, maxTimeoutSeconds: 180, extra: { feePayer: "0.0.40" } };
export const event = { id: "event-1", missionId: mission.id, type: "mission-created", payloadHash: hash, occurredAt: time };
export const paymentAuthorization = { missionId: mission.id, targetSha256: hash, transactionSha256: hash,
  transactionId: tx, borrowerAccountId: request.borrowerAccountId, providerAccountId: provider.accountId,
  scanUrl: `${provider.endpoint}/scan`, amountTinybar: "100", network: "hedera:testnet", asset: "0.0.0",
  nonce: "1", expiresAt: time, signature };
export const fixtures = {
  authorize: { request: { missionId: mission.id, requirements, nonce: "1" }, response: { transaction: "AQID", paymentAuthorization } },
  repay: { request: { missionId: mission.id, loanId: "loan-1", idempotencyKey: "repayment:loan-1" }, response: { transactionId: tx } },
  signCreditRequest: { request: { request }, response: { signature } },
  signCreditAcceptance: { request: { offer }, response: { acceptance, signature } },
  registerLoan: { request: { loanId: "loan-1", request: { ...request, signature }, offer, acceptance, signatures: { acceptance: signature }, fundingTxId: tx }, response: { loanId: "loan-1", state: "funded" } },
  registerMissionPolicy: { request: { missionId: mission.id, borrowerAccountId: request.borrowerAccountId, spendingCapTinybar: "1000", sessionId: "session-1", sessionCapTinybar: "10000", targetSha256: hash, provider, approvedRecipientsRoot: "1" }, response: { missionId: mission.id, status: "registered" } },
  registerLenderMissionPolicy: { request: { missionId: mission.id, borrowerAccountId: request.borrowerAccountId, spendingCapTinybar: "1000", sessionId: "session-1", sessionCapTinybar: "10000", targetSha256: hash, provider, approvedRecipientsRoot: "1" }, response: { missionId: mission.id, status: "registered" } },
  signerCompletion: { request: callback, response: { status: "accepted" } },
  health: { request: undefined, response: { status: "ok", circuitId: "koven-policy-v1", vkeyHash: null } },
  providers: { request: undefined, response: [provider] },
  rankProviders: { request: { capability: "solidity-scan", maxPriceTinybar: "1000" }, response: { ranked: [{ provider, score: 0.8, breakdown: { price: 0.3, reputation: 0.4, latency: 0.1 } }], formula: "price + reputation + latency" } },
  scan: { request: { ...scan, paymentAuthorization }, response: report },
  scanChallenge: { request: scan, response: undefined },
  createMission: { request: { prompt: "Scan Example.sol", maxBudgetTinybar: "1000", targetRef: scan.targetRef, source: scan.source }, response: mission },
  missionDetail: { request: { id: mission.id }, response: { ...mission, events: [event] } },
  completion: { request: callback, response: { status: "accepted" } },
  quote: { request: { ...request, signature }, response: offer },
  quoteDeclined: { request: { ...request, signature }, response: undefined },
  accept: { request: { acceptance, signature }, response: { fundingTxId: tx } },
  error: { request: undefined, response: { code: "request_invalid", detail: "Invalid request" } },
} satisfies Record<HttpContractName, { request: unknown; response: unknown }>;
