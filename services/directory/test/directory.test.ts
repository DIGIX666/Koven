import { readFile } from "node:fs/promises";
import type { Server } from "node:http";

import { createEvent, openDatabase, type KovenDatabase } from "@koven/persistence";
import {
  ErrorResponseSchema,
  ProviderRankResponseSchema,
  ProvidersResponseSchema,
} from "@koven/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeReputation,
  createDirectoryApp,
  DIRECTORY_RANKING_FORMULA,
  getProviderReputation,
  ProviderRegistry,
  REPUTATION_FORMULA,
} from "../src/index.js";

const now = "2026-09-13T10:00:00.000Z";
const servers: Server[] = [];
let database: KovenDatabase;
let providerFixture: unknown;

const listen = async (registry: ProviderRegistry): Promise<string> => {
  const app = createDirectoryApp({ database, registry });
  const server = await new Promise<Server>((resolve, reject) => {
    const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
    candidate.once("error", reject);
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing directory address");
  return `http://127.0.0.1:${address.port}`;
};

const recordOutcome = (
  id: string,
  type: "report-received" | "mission-failed",
  providerId: string,
): void => {
  createEvent(database, {
    id,
    missionId: `mission-${id}`,
    type,
    payloadHash: "a".repeat(64),
    payload: {
      from: type === "report-received" ? "running" : "failed",
      to: type === "report-received" ? "completed" : "recovery",
      detail: { providerId },
    },
    occurredAt: now,
  });
};

beforeEach(async () => {
  database = openDatabase(":memory:");
  const fixtureUrl = new URL("../../../tests/fixtures/providers.json", import.meta.url);
  providerFixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as unknown;
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error));
  })));
  database.close();
});

describe("provider registry", () => {
  it("loads deterministic metadata without persisting a reputation score", () => {
    const registry = new ProviderRegistry(providerFixture);
    const providers = registry.list();

    expect(providers.map(provider => provider.id)).toEqual(["prov-a", "prov-b"]);
    expect(providers.map(provider => provider.priceTinybar)).toEqual([80_000_000n, 45_000_000n]);
    expect(providers.every(provider => !("reputationScore" in provider))).toBe(true);
    expect(() => new ProviderRegistry([...(providerFixture as object[]), (providerFixture as object[])[0]]))
      .toThrow("Provider ids must be unique");
  });

  it("uses the documented Laplace-smoothed reputation formula", () => {
    expect(computeReputation(0, 0)).toBe(0.5);
    expect(computeReputation(1, 0)).toBeCloseTo(2 / 3);
    expect(computeReputation(0, 2)).toBe(0.25);
    expect(() => computeReputation(-1, 0)).toThrow("non-negative safe integers");
  });
});

describe("directory HTTP API", () => {
  it("computes reputation from events and changes rank without registry changes", async () => {
    const registry = new ProviderRegistry(providerFixture);
    const baseUrl = await listen(registry);
    recordOutcome("a-success", "report-received", "prov-a");

    const listed = ProvidersResponseSchema.parse(await (await fetch(`${baseUrl}/providers`)).json());
    expect(listed.map(provider => provider.id)).toEqual(["prov-a", "prov-b"]);
    expect(listed[0]!.reputationScore).toBeCloseTo(2 / 3);
    expect(listed[1]!.reputationScore).toBe(0.5);

    const rankUrl = `${baseUrl}/providers/rank?capability=solidity-scan&maxPriceTinybar=100000000`;
    const initial = ProviderRankResponseSchema.parse(await (await fetch(rankUrl)).json());
    expect(initial.ranked[0]!.provider.id).toBe("prov-b");
    expect(initial.formula).toBe(DIRECTORY_RANKING_FORMULA);
    expect(initial.formula).toContain(REPUTATION_FORMULA);

    recordOutcome("b-failure-1", "mission-failed", "prov-b");
    recordOutcome("b-failure-2", "mission-failed", "prov-b");
    expect(getProviderReputation(database, "prov-b")).toEqual({
      successes: 0,
      failures: 2,
      score: 0.25,
    });

    const afterFailures = ProviderRankResponseSchema.parse(await (await fetch(rankUrl)).json());
    const repeated = ProviderRankResponseSchema.parse(await (await fetch(rankUrl)).json());
    expect(afterFailures.ranked[0]!.provider.id).toBe("prov-a");
    expect(repeated).toEqual(afterFailures);
    expect(registry.list().every(provider => !("reputationScore" in provider))).toBe(true);
  });

  it("rejects an incomplete ranking query with the shared error contract", async () => {
    const baseUrl = await listen(new ProviderRegistry(providerFixture));
    const response = await fetch(`${baseUrl}/providers/rank?capability=solidity-scan`);

    expect(response.status).toBe(400);
    expect(ErrorResponseSchema.parse(await response.json())).toEqual({
      code: "request_invalid",
      detail: "Directory request is invalid",
    });
  });
});
