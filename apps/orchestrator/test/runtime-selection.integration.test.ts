import type { Server } from "node:http";

import type { ConsumerMissionInput, ConsumerMissionObserver } from "@koven/consumer-agent";
import { createEvent, listMissionEvents, openDatabase, type KovenDatabase } from "@koven/persistence";
import { createDirectoryApp, ProviderRegistry } from "@koven/directory";
import type { HttpRequest } from "@koven/schemas";
import { NoopAuditSink } from "@koven/testing";
import { loadPoseidon } from "@koven/x402";
import { buildMissionRecipientRoot } from "@koven/zk-policy";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpProviderDirectory, MissionStateMachine, MissionWorkflow } from "../src/index.js";
import { hashBytes, hashCanonicalJson } from "../src/canonical.js";

const timestamp = "2026-09-13T10:00:00.000Z";
const source = "pragma solidity ^0.8.24; contract RuntimeSelection {}";
const targetSha256 = hashBytes(source);
const providers = [
  {
    id: "prov-a",
    accountId: "0.0.20",
    endpoint: "http://127.0.0.1:3003",
    capability: "solidity-scan",
    priceTinybar: "80000000",
    expectedLatencyMs: 4000,
  },
  {
    id: "prov-b",
    accountId: "0.0.21",
    endpoint: "http://127.0.0.1:3013",
    capability: "solidity-scan",
    priceTinybar: "45000000",
    expectedLatencyMs: 9000,
  },
] as const;

const servers: Server[] = [];
const databases: KovenDatabase[] = [];

const listen = async (database: KovenDatabase): Promise<string> => {
  const app = createDirectoryApp({ database, registry: new ProviderRegistry(providers) });
  const server = await new Promise<Server>((resolve, reject) => {
    const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
    candidate.once("error", reject);
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing directory address");
  return `http://127.0.0.1:${address.port}`;
};

const recordOutcome = (database: KovenDatabase, id: string, type: "report-received" | "mission-failed", providerId: string) => {
  const detail = { providerId };
  createEvent(database, {
    id,
    missionId: `history-${id}`,
    type,
    payloadHash: hashCanonicalJson(detail),
    payload: detail,
    occurredAt: timestamp,
  });
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error));
  })));
  for (const database of databases.splice(0)) database.close();
});

describe("runtime provider selection", () => {
  it("changes the paid provider when only the event-derived reputation changes", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    recordOutcome(database, "a-success", "report-received", "prov-a");
    const directoryUrl = await listen(database);
    const selectedProviders: string[] = [];
    let transactionSequence = 0;
    const consumer = {
      execute: vi.fn(async (input: ConsumerMissionInput, observer?: ConsumerMissionObserver) => {
        selectedProviders.push(input.provider.id);
        transactionSequence += 1;
        const transactionId = `0.0.10@1789293600.${String(transactionSequence).padStart(9, "0")}`;
        const unsignedReport = {
          schemaVersion: 1 as const,
          missionId: input.missionId,
          targetSha256,
          providerId: input.provider.id,
          findings: [],
          startedAt: timestamp,
          completedAt: timestamp,
        };
        const scan = {
          status: 200 as const,
          receipt: {
            missionId: input.missionId,
            transactionId,
            network: "hedera:testnet" as const,
            payer: "0.0.10",
            recipientAccountId: input.provider.accountId,
            asset: "0.0.0" as const,
            amountTinybar: input.provider.priceTinybar,
            settledAt: timestamp,
          },
          report: { ...unsignedReport, reportSha256: hashCanonicalJson(unsignedReport) },
        };
        await observer?.onProgress({ type: "payment-preparation" });
        await observer?.onProgress({
          type: "payment-authorized",
          transactionId,
          nonce: String(transactionSequence),
          amountTinybar: input.provider.priceTinybar,
        });
        await observer?.onProgress({ type: "service-paid", scan });
        return { scan };
      }),
    };
    let missionSequence = 0;
    const registrars = [
      { register: vi.fn(async (_policy: HttpRequest<"registerMissionPolicy">) => undefined) },
      { register: vi.fn(async (_policy: HttpRequest<"registerMissionPolicy">) => undefined) },
      { register: vi.fn(async (_policy: HttpRequest<"registerMissionPolicy">) => undefined) },
    ];
    const poseidon = await loadPoseidon();
    const workflow = new MissionWorkflow({
      database,
      stateMachine: new MissionStateMachine(database, new NoopAuditSink(), {
        now: () => timestamp,
        eventId: () => `event-${++transactionSequence}`,
      }),
      consumer,
      policyRegistrars: registrars,
      providerDirectory: new HttpProviderDirectory({ baseUrl: directoryUrl }),
      borrowerAccountId: "0.0.10",
      poseidon,
      now: () => timestamp,
      missionId: () => `mission-runtime-${++missionSequence}`,
    });
    const request = {
      prompt: "Scan the contract",
      maxBudgetTinybar: "100000000",
      targetRef: "RuntimeSelection.sol",
      source,
    };

    const first = await workflow.run(request);
    for (let index = 1; index <= 4; index += 1) {
      recordOutcome(database, `b-failure-${index}`, "mission-failed", "prov-b");
    }
    const second = await workflow.run(request);

    expect(selectedProviders).toEqual(["prov-b", "prov-a"]);
    expect(first.approvedRecipientsRoot).toBe(buildMissionRecipientRoot("0.0.21", poseidon));
    expect(second.approvedRecipientsRoot).toBe(buildMissionRecipientRoot("0.0.20", poseidon));
    expect(listMissionEvents<{ detail: { formula?: string } }>(database, first.id)
      .find(event => event.type === "providers-ranked")?.payload.detail.formula)
      .toContain("score =");
    expect(registrars.every(registrar => registrar.register.mock.calls.length === 2)).toBe(true);
    expect(registrars.map(registrar => registrar.register.mock.calls.map(([policy]) => policy.provider.id)))
      .toEqual(Array.from({ length: 3 }, () => ["prov-b", "prov-a"]));
  });
});
