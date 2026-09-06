export interface NormalizedChallenge {
  amountTinybar: bigint; recipientAccountId: string; nonce: string;
  resourceHash: string; missionId: string;
}
export interface ProofBundle {
  proof: { protocol: "groth16"; curve: "bn128"; pi_a: [string, string, string];
    pi_b: [[string, string], [string, string], [string, string]];
    pi_c: [string, string, string] };
  publicSignals: [string, string, string]; // commitment, root, cap
  vkeyHash: string; circuitId: string;
}
export interface PaymentRequirements {
  scheme: "exact"; network: "hedera:testnet"; asset: "0.0.0";
  amount: string; payTo: string; maxTimeoutSeconds: number;
  extra: { feePayer: string };
}
export interface PaymentReceipt {
  missionId: string; transactionId: string; network: "hedera:testnet";
  payer: string; recipientAccountId: string; asset: "0.0.0";
  amountTinybar: bigint; settledAt: string;
}

/** Signed by the restricted signer; verified by the provider before settlement. */
export interface ScanPaymentAuthorization {
  missionId: string; targetSha256: string; transactionSha256: string;
  transactionId: string; borrowerAccountId: string; providerAccountId: string;
  scanUrl: string; amountTinybar: bigint; network: "hedera:testnet"; asset: "0.0.0";
  nonce: string; expiresAt: string; signature: string;
}
