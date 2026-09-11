import type { CreditRequest } from "@koven/domain";

export interface LenderPolicyDecision {
  feeTinybar: bigint;
  termSeconds: number;
}

export interface LenderPolicy {
  evaluate(request: CreditRequest, borrowerReputation: number): LenderPolicyDecision | undefined;
}
