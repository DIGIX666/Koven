import { readFile } from "node:fs/promises";

import type { Finding, ScanRequest } from "@koven/domain";
import { FindingSchema, MAX_SOURCE_BYTES, ScanReportSchema } from "@koven/schemas";
import { describe, expect, it, vi } from "vitest";

import { buildReport, canonicalJson, hasValidReportHash } from "../src/report.js";
import { SolhintScanEngine, type ScanEngine } from "../src/scan.js";
import { hashSource, parseBoundScanRequest, ScanServiceError } from "../src/request.js";
import { createScanService, MAX_FINDING_MESSAGE_CHARS, MAX_REPORT_FINDINGS } from "../src/server.js";

const fixtureUrl = (name: string) => new URL(`../../../tests/fixtures/contracts/${name}`, import.meta.url);
const fixture = (name: string) => readFile(fixtureUrl(name), "utf8");

describe("SolhintScanEngine", () => {
  const engine = new SolhintScanEngine();

  it("accepts a clean contract without findings", async () => {
    expect(await engine.scan(await fixture("Clean.sol"), "Clean.sol")).toEqual([]);
  });

  it("reports the reentrancy fixture as high severity", async () => {
    const findings = await engine.scan(await fixture("Reentrancy.sol"), "Reentrancy.sol");

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "reentrancy", severity: "high", file: "Reentrancy.sol" }),
    ]));
  });

  it("reports several low-severity risks deterministically", async () => {
    const source = await fixture("LowSeverity.sol");
    const first = await engine.scan(source, "LowSeverity.sol");
    const second = await engine.scan(source, "LowSeverity.sol");

    expect(first.filter(finding => finding.severity === "low")).toHaveLength(3);
    expect(second).toEqual(first);
  });
});

describe("source binding", () => {
  const source = "pragma solidity ^0.8.24; contract Bound {}";
  const request: ScanRequest = {
    missionId: "mission-1",
    targetRef: "Bound.sol",
    source,
    targetSha256: hashSource(source),
  };

  it("accepts only the exact UTF-8 source committed by targetSha256", () => {
    expect(parseBoundScanRequest(request)).toEqual(request);
    expect(() => parseBoundScanRequest({ ...request, source: `${source}\n` }))
      .toThrow(expect.objectContaining({ code: "source_hash_mismatch", status: 400 }));
  });

  it("rejects oversized source with a safe typed error", () => {
    const oversized = "a".repeat(MAX_SOURCE_BYTES + 1);

    expect(() => parseBoundScanRequest({ ...request, source: oversized }))
      .toThrow(expect.objectContaining({ code: "source_too_large", status: 413 }));
  });

  it("does not scan a request with a mismatched source", async () => {
    const engine: ScanEngine = { id: "fake", scan: vi.fn(async () => []) };
    const service = createScanService({ providerId: "provider-a", engine });

    await expect(service.scan({ ...request, source: `${source} ` })).rejects.toBeInstanceOf(ScanServiceError);
    expect(engine.scan).not.toHaveBeenCalled();
  });
});

describe("scan service", () => {
  it("delivers the clean fixture as a valid report with no findings", async () => {
    const clean = await fixture("Clean.sol");
    const service = createScanService({ providerId: "provider-a" });
    const report = await service.scan({
      missionId: "mission-clean",
      targetRef: "Clean.sol",
      source: clean,
      targetSha256: hashSource(clean),
    });

    expect(report.findings).toEqual([]);
    expect(report.missionId).toBe("mission-clean");
    expect(report.targetSha256).toBe(hashSource(clean));
    expect(ScanReportSchema.safeParse(report).success).toBe(true);
    expect(hasValidReportHash(report)).toBe(true);
  });

  it("fails explicitly, without truncating, when findings exceed the report contract", async () => {
    const finding = (line: number, message = "Avoid time-based decisions"): Finding => ({
      ruleId: "not-rely-on-time",
      severity: "low",
      file: "Bound.sol",
      line,
      message,
    });
    const tooMany = Array.from({ length: MAX_REPORT_FINDINGS + 1 }, (_, index) => finding(index + 1));
    const tooLong = [finding(1, "m".repeat(MAX_FINDING_MESSAGE_CHARS + 1))];
    const request = { missionId: "mission-3", targetRef: "Bound.sol", source: "contract A {}", targetSha256: hashSource("contract A {}") };

    await expect(createScanService({
      providerId: "provider-a",
      engine: { id: "fake", scan: async () => tooMany },
    }).scan(request)).rejects.toMatchObject({ code: "internal_error", status: 500 });
    await expect(createScanService({
      providerId: "provider-a",
      engine: { id: "fake", scan: async () => tooLong },
    }).scan(request)).rejects.toMatchObject({ code: "internal_error", status: 500 });

    const atLimit = await createScanService({
      providerId: "provider-a",
      engine: { id: "fake", scan: async () => [finding(1, "m".repeat(MAX_FINDING_MESSAGE_CHARS))] },
    }).scan(request);
    expect(atLimit.findings[0]!.message).toHaveLength(MAX_FINDING_MESSAGE_CHARS);
  });

  it("keeps the local report limits identical to the frozen schemas", () => {
    const finding = (message: string): Finding => ({ ruleId: "r", severity: "info", file: "f", line: 1, message });
    expect(FindingSchema.safeParse(finding("m".repeat(MAX_FINDING_MESSAGE_CHARS))).success).toBe(true);
    expect(FindingSchema.safeParse(finding("m".repeat(MAX_FINDING_MESSAGE_CHARS + 1))).success).toBe(false);

    const report = (count: number) => ({
      schemaVersion: 1,
      missionId: "m",
      targetSha256: "0".repeat(64),
      providerId: "p",
      findings: Array.from({ length: count }, () => finding("x")),
      startedAt: "2026-09-11T10:00:00.000Z",
      completedAt: "2026-09-11T10:00:00.000Z",
      reportSha256: "0".repeat(64),
    });
    expect(ScanReportSchema.safeParse(report(MAX_REPORT_FINDINGS)).success).toBe(true);
    expect(ScanReportSchema.safeParse(report(MAX_REPORT_FINDINGS + 1)).success).toBe(false);
  });
});

describe("buildReport", () => {
  it("binds a schema-valid report to canonical content without hashing its own hash", () => {
    const source = "pragma solidity ^0.8.24; contract Report {}";
    const request: ScanRequest = {
      missionId: "mission-2",
      targetRef: "Report.sol",
      source,
      targetSha256: hashSource(source),
    };
    const findings: Finding[] = [{
      ruleId: "not-rely-on-time",
      severity: "low",
      file: request.targetRef,
      line: 4,
      message: "Avoid time-based decisions",
    }];
    const report = buildReport(request, "provider-a", findings, {
      startedAt: "2026-09-11T10:00:00.000Z",
      completedAt: "2026-09-11T10:00:01.000Z",
    });

    expect(report.missionId).toBe(request.missionId);
    expect(report.targetSha256).toBe(request.targetSha256);
    expect(hasValidReportHash(report)).toBe(true);
    expect(hasValidReportHash({ ...report, providerId: "provider-b" })).toBe(false);
  });

  it("recomputes the source hash instead of trusting the request field", () => {
    const source = "pragma solidity ^0.8.24; contract Recomputed {}";
    const report = buildReport({
      missionId: "mission-recomputed",
      targetRef: "Recomputed.sol",
      source,
      targetSha256: "0".repeat(64),
    }, "provider-a", [], {
      startedAt: "2026-09-11T10:00:00.000Z",
      completedAt: "2026-09-11T10:00:00.000Z",
    });

    expect(report.targetSha256).toBe(hashSource(source));
    expect(hasValidReportHash(report)).toBe(true);
  });

  it("sorts object keys recursively in canonical JSON", () => {
    expect(canonicalJson({ z: 1, omitted: undefined, nested: { b: 2, a: 1 }, a: [2, 1] }))
      .toBe('{"a":[2,1],"nested":{"a":1,"b":2},"z":1}');
  });
});
