export type LenderPolicyName = "conservative" | "competitive";

/** Multiple lender instances share this package and load distinct policies. */
export const lenderPolicies: readonly LenderPolicyName[] = [
  "conservative",
  "competitive",
];

export * from "./fund.js";
export * from "./policy.js";
export * from "./policies/conservative.js";
export * from "./server.js";
export * from "./store.js";
