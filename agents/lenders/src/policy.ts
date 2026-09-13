import type { CreditRequest } from "@koven/domain";
import { UINT64_MAX } from "@koven/schemas";

export interface LenderPolicyDecision {
  feeTinybar: bigint;
  termSeconds: number;
}

export interface LenderPolicy {
  evaluate(request: CreditRequest, borrowerReputation: number): LenderPolicyDecision | undefined;
}

export interface LenderPolicyOptions {
  readonly maxPrincipalTinybar: bigint;
  readonly feeBps: number;
  readonly maxTermSeconds: number;
  readonly minReputationScore: number;
}

export function validateLenderPolicyOptions(options: LenderPolicyOptions): void {
  if (options.maxPrincipalTinybar <= 0n) throw new RangeError("Maximum principal must be positive");
  if (!Number.isInteger(options.maxTermSeconds) || options.maxTermSeconds <= 0) {
    throw new RangeError("Maximum term must be a positive integer");
  }
  if (!Number.isFinite(options.minReputationScore)
    || options.minReputationScore < 0 || options.minReputationScore > 1) {
    throw new RangeError("Minimum reputation must be between zero and one");
  }
  if (!Number.isSafeInteger(options.feeBps) || options.feeBps < 0) {
    throw new RangeError("Fee basis points must be a non-negative integer");
  }
}

export function evaluateLenderPolicy(
  options: LenderPolicyOptions,
  request: CreditRequest,
  borrowerReputation: number,
): LenderPolicyDecision | undefined {
  if (request.principalTinybar <= 0n
    || request.principalTinybar > options.maxPrincipalTinybar
    || !Number.isInteger(request.requestedTermSeconds)
    || request.requestedTermSeconds <= 0
    || request.requestedTermSeconds > options.maxTermSeconds
    || !Number.isFinite(borrowerReputation)
    || borrowerReputation < options.minReputationScore) {
    return undefined;
  }
  const feeTinybar = (request.principalTinybar * BigInt(options.feeBps) + 9_999n) / 10_000n;
  if (request.principalTinybar + feeTinybar > UINT64_MAX) return undefined;
  return { feeTinybar, termSeconds: request.requestedTermSeconds };
}
