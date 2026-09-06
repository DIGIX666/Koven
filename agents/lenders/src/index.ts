export type LenderPolicyName = "conservative" | "competitive";

/** Multiple lender instances share this package and load distinct policies. */
export const lenderPolicies: readonly LenderPolicyName[] = [
  "conservative",
  "competitive",
];

