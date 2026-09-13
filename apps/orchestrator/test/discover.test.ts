import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { HttpProviderDirectory, ProviderDirectoryError } from "../src/index.js";

const wireResult = {
  ranked: [{
    provider: {
      id: "provider-fast",
      accountId: "0.0.20",
      endpoint: "https://provider.example",
      capability: "solidity-scan",
      priceTinybar: "100",
      reputationScore: 0.8,
      expectedLatencyMs: 50,
    },
    score: 0.75,
    breakdown: { price: 0.7, reputation: 0.8, latency: 0.75 },
  }],
  formula: "deterministic ranking",
};

describe("HttpProviderDirectory", () => {
  it("requests the frozen rank endpoint and converts tinybar values to the domain type", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => (
      new Response(JSON.stringify(wireResult), { status: 200 })
    ));
    const directory = new HttpProviderDirectory({
      baseUrl: "https://directory.example",
      fetch: fetchMock,
    });

    const result = await directory.rank({ capability: "solidity-scan", maxPriceTinybar: "1000" });

    expect(result).toEqual({
      ...wireResult,
      ranked: [{
        ...wireResult.ranked[0],
        provider: { ...wireResult.ranked[0]!.provider, priceTinybar: 100n },
      }],
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://directory.example/providers/rank?capability=solidity-scan&maxPriceTinybar=1000",
    );
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
  });

  it("preserves directory errors and classifies transport failures", async () => {
    const refused = new HttpProviderDirectory({
      baseUrl: "https://directory.example",
      fetch: vi.fn(async () => new Response(JSON.stringify({
        code: "request_invalid",
        detail: "invalid rank query",
      }), { status: 400 })),
    });
    await expect(refused.rank({ capability: "solidity-scan", maxPriceTinybar: "1" }))
      .rejects.toEqual(new ProviderDirectoryError(400, "request_invalid", "invalid rank query"));

    const unavailable = new HttpProviderDirectory({
      baseUrl: "https://directory.example",
      fetch: vi.fn(async () => { throw new TypeError("offline"); }),
    });
    await expect(unavailable.rank({ capability: "solidity-scan", maxPriceTinybar: "1" }))
      .rejects.toMatchObject({ status: 503, code: "internal_error" });
  });

  it("rejects untrusted origins and invalid timeout settings", () => {
    expect(() => new HttpProviderDirectory({ baseUrl: "http://directory.example" })).toThrow(/HTTPS/);
    expect(() => new HttpProviderDirectory({ baseUrl: "https://user@directory.example" })).toThrow(/HTTPS/);
    expect(() => new HttpProviderDirectory({ baseUrl: "https://directory.example/api" })).toThrow(/HTTPS/);
    expect(() => new HttpProviderDirectory({ baseUrl: "https://directory.example", timeoutMs: 0 })).toThrow(/timeout/);
  });
});

const sourceFiles = async (directory: URL): Promise<URL[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) return sourceFiles(url);
    return entry.isFile() && entry.name.endsWith(".ts") ? [url] : [];
  }));
  return nested.flat();
};

describe("runtime selection guard", () => {
  it("keeps concrete provider identities out of orchestrator source", async () => {
    const files = await sourceFiles(new URL("../src/", import.meta.url));
    const source = (await Promise.all(files.map(file => readFile(file, "utf8")))).join("\n");

    for (const identity of ["prov-a", "prov-b", "lender-a", "lender-b"]) {
      expect(source).not.toContain(identity);
    }
  });
});
