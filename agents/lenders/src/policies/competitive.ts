import type { CreditRequest } from "@koven/domain";

import {
  evaluateLenderPolicy,
  type LenderPolicy,
  type LenderPolicyDecision,
  type LenderPolicyOptions,
  validateLenderPolicyOptions,
} from "../policy.js";

export type CompetitivePolicyOptions = LenderPolicyOptions;

export const COMPETITIVE_LENDER_POSTURE: CompetitivePolicyOptions = {
  maxPrincipalTinybar: 2_500_000_000n,
  feeBps: 500,
  maxTermSeconds: 1_800,
  minReputationScore: 0.4,
};

/** Higher-capacity policy used by the second lender agent. */
export class CompetitiveLenderPolicy implements LenderPolicy {
  constructor(private readonly options: CompetitivePolicyOptions = COMPETITIVE_LENDER_POSTURE) {
    validateLenderPolicyOptions(options);
  }

  evaluate(request: CreditRequest, borrowerReputation: number): LenderPolicyDecision | undefined {
    return evaluateLenderPolicy(this.options, request, borrowerReputation);
  }
}
