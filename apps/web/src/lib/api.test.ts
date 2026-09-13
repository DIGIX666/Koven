import { describe, expect, it, vi } from "vitest";

import { missionFixture, providerRankingFixture } from "../test-fixtures";
import { DashboardApi, DashboardApiError } from "./api";

const jsonResponse = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" },
  ...init,
});

describe("DashboardApi", () => {
  it("validates a mission response against the shared contract", async () => {
    const fetcher = vi.fn(async () => jsonResponse(missionFixture)) as unknown as typeof fetch;
    const api = new DashboardApi({ orchestratorUrl: "https://orchestrator.example", fetch: fetcher });

    await expect(api.mission("mission-demo-1")).resolves.toEqual(missionFixture);
    expect(fetcher).toHaveBeenCalledWith(
      "https://orchestrator.example/missions/mission-demo-1",
      expect.objectContaining({ cache: "no-store", method: "GET" }),
    );
  });

  it("builds a canonical provider-ranking query", async () => {
    const fetcher = vi.fn(async () => jsonResponse(providerRankingFixture)) as unknown as typeof fetch;
    const api = new DashboardApi({ directoryUrl: "https://directory.example/", fetch: fetcher });

    await api.rankedProviders({ capability: "solidity-security", maxPriceTinybar: "2500000000" });
    expect(fetcher).toHaveBeenCalledWith(
      "https://directory.example/providers/rank?capability=solidity-security&maxPriceTinybar=2500000000",
      expect.any(Object),
    );
  });

  it("rejects credentials and non-http dashboard service URLs", () => {
    expect(() => new DashboardApi({ orchestratorUrl: "https://user:secret@example.com" }))
      .toThrowError(DashboardApiError);
    expect(() => new DashboardApi({ directoryUrl: "file:///tmp/data" }))
      .toThrowError(/Invalid dashboard service URL/);
  });

  it("rejects invalid mission ids before contacting the service", () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const api = new DashboardApi({ fetch: fetcher });
    expect(() => api.mission("../secret")).toThrowError(/Mission id is invalid/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects non-canonical tinybar query values", () => {
    const api = new DashboardApi();
    expect(() => api.rankedProviders({ capability: "solidity-security", maxPriceTinybar: "01" }))
      .toThrowError(/canonical tinybar/);
  });

  it("classifies HTTP failures without exposing response bodies", async () => {
    const fetcher = vi.fn(async () => new Response("private upstream detail", { status: 503 })) as unknown as typeof fetch;
    const api = new DashboardApi({ fetch: fetcher });
    await expect(api.mission("mission-1")).rejects.toMatchObject({ kind: "http", status: 503 });
    await expect(api.mission("mission-1")).rejects.not.toThrow(/private upstream detail/);
  });

  it("fails closed when JSON violates the shared schema", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ ...missionFixture, spentTinybar: 10 })) as unknown as typeof fetch;
    const api = new DashboardApi({ fetch: fetcher });
    await expect(api.mission("mission-1")).rejects.toMatchObject({ kind: "contract" });
  });

  it("distinguishes malformed JSON from a network failure", async () => {
    const malformed = vi.fn(async () => new Response("not-json", { status: 200 })) as unknown as typeof fetch;
    const network = vi.fn(async () => { throw new Error("connection refused: internal detail"); }) as unknown as typeof fetch;
    await expect(new DashboardApi({ fetch: malformed }).mission("mission-1"))
      .rejects.toMatchObject({ kind: "contract" });
    await expect(new DashboardApi({ fetch: network }).mission("mission-1"))
      .rejects.toMatchObject({ kind: "network" });
  });
});

