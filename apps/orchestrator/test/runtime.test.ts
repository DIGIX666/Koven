import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HcsPublisher } from "@koven/audit";
import { EnvironmentValidationError } from "@koven/config";
import { PrivateKey } from "@koven/hedera";
import { createEvent, listMissionEvents, openDatabase } from "@koven/persistence";
import { MissionDetailResponseSchema } from "@koven/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOrchestratorRuntime, loadOrchestratorConfig, MirrorBalanceReader } from "../src/index.js";

const lenderKey = PrivateKey.generateECDSA();
const otherLenderKey = PrivateKey.generateECDSA();
const secret = Buffer.alloc(32, 7).toString("base64url");

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close(() => address && typeof address !== "string" ? resolve(address.port) : reject(new Error("No port")));
  });
});

const environment = (overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  ORCHESTRATOR_PORT: "3001",
  ORCHESTRATOR_DATABASE_URL: ":memory:",
  CONSUMER_ACCOUNT_ID: "0.0.1001",
  HEDERA_MIRROR_NODE_URL: "https://testnet.mirrornode.hedera.com",
  SIGNER_URL: "http://127.0.0.1:3004",
  SIGNER_CONSUMER_CREDENTIAL: "c".repeat(43),
  SIGNER_ORCHESTRATOR_CREDENTIAL: "o".repeat(43),
  REGISTRAR_URL: "http://127.0.0.1:3006",
  LENDER_A_URL: "http://127.0.0.1:3005",
  LENDER_A_ACCOUNT_ID: "0.0.2001",
  LENDER_B_URL: "http://127.0.0.1:3015",
  LENDER_B_ACCOUNT_ID: "0.0.2002",
  SIGNER_LENDER_PUBLIC_KEYS: `0.0.2001:${lenderKey.publicKey.toStringRaw()};0.0.2002:${otherLenderKey.publicKey.toStringRaw()}`,
  SIGNER_PROVIDER_CALLBACK_SECRETS: `prov-a:${secret};prov-b:${secret}`,
  // Secrets of other processes must never be needed here.
  CONSUMER_PRIVATE_KEY: "must-not-be-read",
  LENDER_A_PRIVATE_KEY: "must-not-be-read",
  ...overrides,
});

const servers: Server[] = [];
const closers: (() => void)[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  closers.splice(0).forEach(close => close());
});

describe("orchestrator configuration", () => {
  it("loads a complete configuration without any private key of its own", () => {
    const config = loadOrchestratorConfig(environment());
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 3001,
      borrowerAccountId: "0.0.1001",
      signerUrl: "http://127.0.0.1:3004",
      registrarUrl: "http://127.0.0.1:3006",
      proofMode: "deterministic",
      alwaysBorrow: false,
      audit: { mode: "noop" },
    });
    expect(config.lenders.map(lender => lender.accountId)).toEqual(["0.0.2001", "0.0.2002"]);
    expect(Object.keys(config.providerCallbackSecrets)).toEqual(["prov-a", "prov-b"]);
    expect(JSON.stringify(config)).not.toContain("must-not-be-read");
  });

  it("reports every invalid key and refuses a lender without a pinned key or an hcs sink without a topic", () => {
    expect(() => loadOrchestratorConfig(environment({
      ORCHESTRATOR_PORT: "70000",
      SIGNER_URL: "http://signer.example",
      SIGNER_CONSUMER_CREDENTIAL: "short",
      SIGNER_LENDER_PUBLIC_KEYS: `0.0.2001:${lenderKey.publicKey.toStringRaw()}`,
      AUDIT_SINK: "hcs",
    }))).toThrowError(expect.objectContaining({
      keys: ["HCS_AUDIT_TOPIC_ID", "HEDERA_OPERATOR_ID", "HEDERA_OPERATOR_PRIVATE_KEY", "LENDER_B_URL", "ORCHESTRATOR_PORT", "SIGNER_CONSUMER_CREDENTIAL", "SIGNER_URL"],
    }));
    expect(() => loadOrchestratorConfig({})).toThrowError(EnvironmentValidationError);
    expect(loadOrchestratorConfig(environment({ LENDER_B_URL: undefined })).lenders).toHaveLength(1);
    expect(loadOrchestratorConfig(environment({ SIGNER_PROOF_MODE: "zk", ORCHESTRATOR_ALWAYS_BORROW: "true" })))
      .toMatchObject({ proofMode: "zk", alwaysBorrow: true });
  });
});

describe("orchestrator runtime", () => {
  it("serves the mission read API over a persisted database and resumes pending audit entries", async () => {
    const directory = mkdtempSync(join(tmpdir(), "koven-orchestrator-"));
    closers.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "orchestrator.sqlite");
    // A mission persisted by an earlier process, with one attestation still pending.
    const seed = openDatabase(path);
    seed.prepare(`
      INSERT INTO missions (id, state, spending_cap_tinybar, spent_tinybar, approved_recipients_root, target_ref, target_sha256, created_at, updated_at)
      VALUES ('mission-1', 'closed', '100000000', '45000000', '1', 'Vault.sol', '${"a".repeat(64)}', '2026-09-13T10:00:00.000Z', '2026-09-13T10:05:00.000Z')
    `).run();
    createEvent(seed, {
      id: "event-1", missionId: "mission-1", type: "x402-settled", payloadHash: "b".repeat(64),
      transactionId: "0.0.7162784@1789298337.883321289", occurredAt: "2026-09-13T10:02:00.000Z", payload: { amountTinybar: "45000000" },
    });
    seed.close();

    const publisher: HcsPublisher = {
      prepare: vi.fn(async () => ({ transactionId: "0.0.10@1789298400.000000001", transactionBase64: "c2lnbmVk", validUntil: Date.now() + 180_000 })),
      submit: vi.fn(async () => ({ status: "confirmed" as const, sequenceNumber: 12n })),
      reconcile: vi.fn(async () => ({ status: "uncertain" as const })),
    };
    const port = await freePort();
    const runtime = createOrchestratorRuntime(loadOrchestratorConfig(environment({
      ORCHESTRATOR_PORT: String(port),
      ORCHESTRATOR_DATABASE_URL: path,
      AUDIT_SINK: "hcs",
      HCS_AUDIT_TOPIC_ID: "0.0.50",
      HEDERA_OPERATOR_ID: "0.0.10",
      HEDERA_OPERATOR_PRIVATE_KEY: "unused-with-an-injected-publisher",
    })), { publisher });
    closers.push(() => runtime.close());
    servers.push(await runtime.listen());

    // The writer resumed the pending attestation as soon as the process served again.
    await runtime.audit.flush(5_000);
    expect(publisher.submit).toHaveBeenCalledTimes(1);
    expect(listMissionEvents(runtime.database, "mission-1")[0]).toMatchObject({ hcsSequenceNumber: 12n });

    // A published event still satisfies the frozen read contract: HCS columns never leak into the response.
    const response = await fetch(`http://127.0.0.1:${port}/missions/mission-1`);
    expect(response.status, await response.clone().text()).toBe(200);
    const detail = MissionDetailResponseSchema.parse(await response.json());
    expect(detail).toMatchObject({ id: "mission-1", state: "closed", spentTinybar: "45000000" });
    expect(detail.events.map(event => event.type)).toEqual(["x402-settled"]);
    expect((await fetch(`http://127.0.0.1:${port}/missions/mission-unknown`)).status).toBe(404);
  });

  it("starts network-free in noop mode and serves an empty read API", async () => {
    const port = await freePort();
    const runtime = createOrchestratorRuntime(loadOrchestratorConfig(environment({ ORCHESTRATOR_PORT: String(port) })));
    closers.push(() => runtime.close());
    servers.push(await runtime.listen());
    expect((await fetch(`http://127.0.0.1:${port}/missions/mission-1`)).status).toBe(404);
    await expect(runtime.audit.flush(100)).resolves.toBeUndefined();
  });
});

describe("MirrorBalanceReader", () => {
  it("reads the tinybar balance from the account resource and fails closed otherwise", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.1001");
      return new Response(JSON.stringify({ account: "0.0.1001", balance: { balance: 4500000000, timestamp: "1.000000000" } }));
    }) as unknown as typeof fetch;
    const reader = new MirrorBalanceReader({ mirrorNodeUrl: "https://testnet.mirrornode.hedera.com", fetch: fetcher });
    await expect(reader.getBalanceTinybar("0.0.1001")).resolves.toBe(4_500_000_000n);
    const broken = new MirrorBalanceReader({
      mirrorNodeUrl: "https://testnet.mirrornode.hedera.com",
      fetch: (async () => new Response(JSON.stringify({ balance: { balance: "1" } }))) as unknown as typeof fetch,
    });
    await expect(broken.getBalanceTinybar("0.0.1001")).rejects.toThrow(/unavailable/);
    await expect(reader.getBalanceTinybar("not-an-account")).rejects.toThrow(/invalid/);
  });
});
