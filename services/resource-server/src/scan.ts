import { createRequire } from "node:module";

import type { Finding, Severity } from "@koven/domain";

export interface ScanEngine {
  readonly id: string;
  scan(source: string, ref: string): Promise<Finding[]>;
}

interface SolhintMessage {
  readonly line?: number;
  readonly message?: string;
  readonly ruleId?: string;
}

interface SolhintReport {
  readonly messages: readonly SolhintMessage[];
}

interface SolhintApi {
  processStr(source: string, config: object, fileName?: string): SolhintReport;
}

const require = createRequire(import.meta.url);
const solhint = require("solhint") as SolhintApi;

const SOLHINT_CONFIG = Object.freeze({
  rules: {
    "avoid-low-level-calls": "warn",
    "avoid-sha3": "warn",
    "avoid-suicide": "error",
    "avoid-throw": "warn",
    "avoid-tx-origin": "error",
    "check-send-result": "error",
    "multiple-sends": "warn",
    "no-complex-fallback": "warn",
    "no-inline-assembly": "warn",
    "no-unchecked-calls": "error",
    "not-rely-on-block-hash": "warn",
    "not-rely-on-time": "warn",
    reentrancy: "error",
  },
});

const HIGH_SEVERITY_RULES = new Set([
  "avoid-suicide",
  "avoid-tx-origin",
  "reentrancy",
  "solidity-parse-error",
]);

const MEDIUM_SEVERITY_RULES = new Set([
  "avoid-low-level-calls",
  "check-send-result",
  "multiple-sends",
  "no-complex-fallback",
  "no-inline-assembly",
  "no-unchecked-calls",
]);

const LOW_SEVERITY_RULES = new Set([
  "avoid-sha3",
  "avoid-throw",
  "not-rely-on-block-hash",
  "not-rely-on-time",
]);

function severityFor(ruleId: string): Severity {
  if (HIGH_SEVERITY_RULES.has(ruleId)) return "high";
  if (MEDIUM_SEVERITY_RULES.has(ruleId)) return "medium";
  if (LOW_SEVERITY_RULES.has(ruleId)) return "low";
  return "info";
}

function compareFindings(left: Finding, right: Finding): number {
  return left.line - right.line
    || left.ruleId.localeCompare(right.ruleId)
    || left.message.localeCompare(right.message);
}

/** Runs an intentionally fixed Solhint security profile over in-memory source. */
export class SolhintScanEngine implements ScanEngine {
  readonly id = "solhint-6.2.4";

  async scan(source: string, ref: string): Promise<Finding[]> {
    const report = solhint.processStr(source, SOLHINT_CONFIG, ref);

    return report.messages
      .map((entry): Finding => {
        const ruleId = entry.ruleId ?? "solidity-parse-error";
        return {
          ruleId,
          severity: severityFor(ruleId),
          file: ref,
          line: Math.max(1, entry.line ?? 1),
          message: (entry.message ?? "Solhint reported an unspecified issue").slice(0, 4096),
        };
      })
      .sort(compareFindings)
      .slice(0, 1000);
  }
}
