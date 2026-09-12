import { canonicalJson as providerCanonicalJson } from "@koven/resource-server";
import { describe, expect, it } from "vitest";

import { canonicalHash, canonicalJson, signDomain, verifyDomain, withoutSignature } from "../src/canonical.js";
import { consumerKey } from "./helpers.js";

describe("canonical JSON", () => {
  it("sorts keys by ASCII order recursively, omits undefined and renders bigint as decimal", () => {
    const value = { z: 1n, a: [{ d: undefined, c: 2, B: "x" }], m: { y: null, x: "é\\n" }, A: true };
    expect(canonicalJson(value)).toBe('{"A":true,"a":[{"B":"x","c":2}],"m":{"x":"é\\\\n","y":null},"z":"1"}');
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalHash({ b: 1, a: 2 })).toBe(canonicalHash({ a: 2, b: 1 }));
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
    expect(() => canonicalJson({ n: 2 ** 53 })).toThrow();
    expect(() => canonicalJson([1, undefined])).toThrow();
  });

  it("matches the resource server's canonical form for report payloads", () => {
    const report = { schemaVersion: 1, missionId: "m", targetSha256: "1".repeat(64), providerId: "p", findings: [{ ruleId: "r", severity: "low", file: "f", line: 3, message: "x" }], startedAt: "2026-09-12T12:00:00.000Z", completedAt: "2026-09-12T12:00:00.000Z" };
    expect(canonicalJson(report)).toBe(providerCanonicalJson(report));
  });

  it("signs and verifies domain-separated payloads; a different domain or field fails", () => {
    const payload = { amountTinybar: 1n, id: "x" };
    const signature = signDomain(consumerKey, "koven:test:v1", payload);
    expect(signature).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyDomain(consumerKey.publicKey, "koven:test:v1", payload, signature)).toBe(true);
    expect(verifyDomain(consumerKey.publicKey, "koven:test:v1", { ...payload, amountTinybar: "1" }, signature)).toBe(true);
    expect(verifyDomain(consumerKey.publicKey, "koven:other:v1", payload, signature)).toBe(false);
    expect(verifyDomain(consumerKey.publicKey, "koven:test:v1", { ...payload, id: "y" }, signature)).toBe(false);
    expect(verifyDomain(consumerKey.publicKey, "koven:test:v1", payload, "zz")).toBe(false);
    expect(withoutSignature({ ...payload, signature })).toEqual(payload);
  });
});
