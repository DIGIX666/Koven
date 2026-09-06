/**
 * Isolated signing boundary. This service must verify policy proofs, exact
 * challenge binding, lifecycle state, and replay protection before signing.
 */
export const restrictedSigner = {
  name: "koven-restricted-signer",
  status: "scaffolded",
} as const;

