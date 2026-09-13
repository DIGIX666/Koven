import type { CreditRequest } from "@koven/domain";

import {
  evaluateLenderPolicy,
  type LenderPolicy,
  type LenderPolicyDecision,
  type LenderPolicyOptions,
  validateLenderPolicyOptions,
} from "../policy.js";

export type ConservativePolicyOptions = LenderPolicyOptions;

export const CONSERVATIVE_LENDER_POSTURE: ConservativePolicyOptions = {
  maxPrincipalTinybar: 500_000_000n,
  feeBps: 200,
  maxTermSeconds: 600,
  minReputationScore: 0.7,
};

/** Deterministic policy used by the first lender agent. */
export class ConservativeLenderPolicy implements LenderPolicy {
  constructor(private readonly options: ConservativePolicyOptions = CONSERVATIVE_LENDER_POSTURE) {
    validateLenderPolicyOptions(options);
  }

  evaluate(request: CreditRequest, borrowerReputation: number): LenderPolicyDecision | undefined {
    return evaluateLenderPolicy(this.options, request, borrowerReputation);
  }
}
