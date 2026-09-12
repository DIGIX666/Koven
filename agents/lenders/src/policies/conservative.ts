import type { CreditRequest } from "@koven/domain";
import { UINT64_MAX } from "@koven/schemas";

import type { LenderPolicy, LenderPolicyDecision } from "../policy.js";

export interface ConservativePolicyOptions {
  maxPrincipalTinybar: bigint;
  maxTermSeconds: number;
  minimumReputation: number;
  feeBasisPoints: number;
}

/** Deterministic policy used by the first lender agent. */
export class ConservativeLenderPolicy implements LenderPolicy {
  constructor(private readonly options: ConservativePolicyOptions) {
    if (options.maxPrincipalTinybar <= 0n) throw new RangeError("Maximum principal must be positive");
    if (!Number.isInteger(options.maxTermSeconds) || options.maxTermSeconds <= 0) {
      throw new RangeError("Maximum term must be a positive integer");
    }
    if (!Number.isFinite(options.minimumReputation)
      || options.minimumReputation < 0 || options.minimumReputation > 1) {
      throw new RangeError("Minimum reputation must be between zero and one");
    }
    if (!Number.isSafeInteger(options.feeBasisPoints) || options.feeBasisPoints < 0) {
      throw new RangeError("Fee basis points must be a non-negative integer");
    }
  }

  evaluate(request: CreditRequest, borrowerReputation: number): LenderPolicyDecision | undefined {
    if (request.principalTinybar <= 0n
      || request.principalTinybar > this.options.maxPrincipalTinybar
      || !Number.isInteger(request.requestedTermSeconds)
      || request.requestedTermSeconds <= 0
      || request.requestedTermSeconds > this.options.maxTermSeconds
      || !Number.isFinite(borrowerReputation)
      || borrowerReputation < this.options.minimumReputation) {
      return undefined;
    }
    const feeTinybar = (
      request.principalTinybar * BigInt(this.options.feeBasisPoints) + 9_999n
    ) / 10_000n;
    if (request.principalTinybar + feeTinybar > UINT64_MAX) return undefined;
    return {
      feeTinybar,
      termSeconds: request.requestedTermSeconds,
    };
  }
}
