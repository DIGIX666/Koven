import type { Server } from "node:http";

import type { HcsPublisher } from "@koven/audit";
import { HederaHcsPublisher } from "@koven/audit/node";
import { EnvironmentValidationError } from "@koven/config";
import {
  ConsumerMissionExecutor,
  ConsumerPaymentService,
  HttpCreditSigner,
  HttpLender,
  ZkPolicyProver,
} from "@koven/consumer-agent";
import { createClient, PublicKey, type Client } from "@koven/hedera";
import { openDatabase, type KovenDatabase } from "@koven/persistence";
import { decodeCallbackSecret, MirrorTransferConfirmer } from "@koven/restricted-signer";
import { AccountId, Id } from "@koven/schemas";
import { createHttpPaymentAuthorizer } from "@koven/x402";

import { createOrchestratorApp } from "./api/app.js";
import { createOrchestratorAuditRuntime, type OrchestratorAuditRuntime } from "./audit.js";
import { CompletionHandler, HttpSignerCompletionClient } from "./callbacks/completion.js";
import { emptyBalanceReader, MirrorBalanceReader } from "./ledger.js";
import { MissionStateMachine } from "./state/mission-state-machine.js";
import { HttpProviderDirectory } from "./workflows/discover.js";
import { MissionWorkflow } from "./workflows/mission-workflow.js";
import { HttpMissionPolicyRegistrar } from "./workflows/policy.js";
import { HttpRepaymentClient, RepaymentWorkflow } from "./workflows/repay.js";

type EnvironmentSource = Record<string, string | undefined>;

const CREDENTIAL = /^[A-Za-z0-9_-]{43,}$/;
const DEFAULT_HOST = "127.0.0.1";

export interface OrchestratorLenderConfig {
  readonly accountId: string;
  readonly baseUrl: string;
  readonly publicKey: string;
}

export interface OrchestratorConfig {
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly borrowerAccountId: string;
  readonly mirrorNodeUrl: string;
  readonly signerUrl: string;
  readonly consumerCredential: string;
  readonly orchestratorCredential: string;
  readonly registrarUrl: string;
  readonly lenders: readonly OrchestratorLenderConfig[];
  readonly providerCallbackSecrets: Readonly<Record<string, Uint8Array>>;
  readonly proofMode: "deterministic" | "zk";
  /** Demo setting: borrow the full price instead of reading the borrower's Mirror Node balance. */
  readonly alwaysBorrow: boolean;
  readonly audit: { readonly mode: "noop" } | {
    readonly mode: "hcs";
    readonly topicId: string;
    readonly operatorId: string;
    readonly operatorPrivateKey: string;
  };
}

function pairs(value: string): [string, string][] {
  return value.split(";").filter(entry => entry.length > 0).map(entry => {
    const separator = entry.indexOf(":");
    if (separator <= 0 || separator === entry.length - 1) throw new Error("Malformed map entry");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  });
}

function trustedOrigin(value: string): string {
  const url = new URL(value);
  const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Expected an HTTPS or loopback origin");
  }
  return url.toString().replace(/\/$/, "");
}

function bindHost(value: string): string {
  const hostname = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(value);
  const ipv6 = /^[0-9A-Fa-f:]+$/.test(value) && value.includes(":");
  if (!hostname && !ipv6) throw new Error("Invalid bind host");
  return value;
}

function port(value: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || parsed < 1 || parsed > 65_535) throw new Error("Invalid port");
  return parsed;
}

/**
 * Loads the orchestrator's process configuration. It holds no Hedera key of
 * its own (the HCS operator key is used only by the audit publisher in `hcs`
 * mode) and reaches every other service through pinned loopback or HTTPS
 * origins with opaque credentials.
 */
export function loadOrchestratorConfig(source: EnvironmentSource = process.env): OrchestratorConfig {
  const invalid: string[] = [];
  const required = (key: string): string => {
    const value = source[key];
    if (!value) invalid.push(key);
    return value ?? "";
  };
  const validate = <T>(key: string, parse: () => T): T | undefined => {
    try {
      return parse();
    } catch {
      invalid.push(key);
      return undefined;
    }
  };
  const credential = (key: string): string => {
    const value = required(key);
    if (value && !CREDENTIAL.test(value)) invalid.push(key);
    return value;
  };

  const host = validate("ORCHESTRATOR_HOST", () => bindHost(source.ORCHESTRATOR_HOST || DEFAULT_HOST));
  const listenPort = validate("ORCHESTRATOR_PORT", () => port(required("ORCHESTRATOR_PORT")));
  const databasePath = required("ORCHESTRATOR_DATABASE_URL");
  const borrowerAccountId = validate("CONSUMER_ACCOUNT_ID", () => AccountId.parse(required("CONSUMER_ACCOUNT_ID")));
  const mirrorNodeUrl = validate("HEDERA_MIRROR_NODE_URL", () => trustedOrigin(required("HEDERA_MIRROR_NODE_URL")));
  const signerUrl = validate("SIGNER_URL", () => trustedOrigin(required("SIGNER_URL")));
  const consumerCredential = credential("SIGNER_CONSUMER_CREDENTIAL");
  const orchestratorCredential = credential("SIGNER_ORCHESTRATOR_CREDENTIAL");
  const registrarUrl = validate("REGISTRAR_URL", () => trustedOrigin(required("REGISTRAR_URL")));

  const lenderKeys = validate("SIGNER_LENDER_PUBLIC_KEYS", () => {
    const map: Record<string, string> = {};
    for (const [accountId, key] of pairs(required("SIGNER_LENDER_PUBLIC_KEYS"))) {
      map[AccountId.parse(accountId)] = PublicKey.fromStringECDSA(key).toStringRaw();
    }
    return map;
  }) ?? {};
  const lenders: OrchestratorLenderConfig[] = [];
  for (const name of ["A", "B"] as const) {
    const baseUrl = source[`LENDER_${name}_URL`];
    if (!baseUrl) {
      if (name === "A") invalid.push("LENDER_A_URL");
      continue;
    }
    validate(`LENDER_${name}_URL`, () => {
      const accountId = AccountId.parse(required(`LENDER_${name}_ACCOUNT_ID`));
      const publicKey = lenderKeys[accountId];
      if (publicKey === undefined) throw new Error(`No pinned public key for lender ${name}`);
      lenders.push({ accountId, baseUrl: trustedOrigin(baseUrl), publicKey });
    });
  }

  const providerCallbackSecrets = validate("SIGNER_PROVIDER_CALLBACK_SECRETS", () => {
    const map: Record<string, Uint8Array> = {};
    for (const [providerId, secret] of pairs(required("SIGNER_PROVIDER_CALLBACK_SECRETS"))) {
      map[Id.parse(providerId)] = decodeCallbackSecret(secret);
    }
    if (Object.keys(map).length === 0) throw new Error("At least one provider callback secret is required");
    return map;
  });
  const proofMode = validate("SIGNER_PROOF_MODE", (): "deterministic" | "zk" => {
    const value = source.SIGNER_PROOF_MODE || "deterministic";
    if (value !== "deterministic" && value !== "zk") throw new Error("Unsupported proof mode");
    return value;
  });
  const alwaysBorrow = validate("ORCHESTRATOR_ALWAYS_BORROW", () => {
    const value = source.ORCHESTRATOR_ALWAYS_BORROW || "false";
    if (value !== "true" && value !== "false") throw new Error("Expected true or false");
    return value === "true";
  });
  const auditMode = validate("AUDIT_SINK", (): "noop" | "hcs" => {
    const value = source.AUDIT_SINK || "noop";
    if (value !== "noop" && value !== "hcs") throw new Error("Unsupported audit sink");
    return value;
  });
  const audit: OrchestratorConfig["audit"] | undefined = auditMode === "hcs"
    ? {
      mode: "hcs",
      topicId: validate("HCS_AUDIT_TOPIC_ID", () => AccountId.parse(required("HCS_AUDIT_TOPIC_ID"))) ?? "",
      operatorId: validate("HEDERA_OPERATOR_ID", () => AccountId.parse(required("HEDERA_OPERATOR_ID"))) ?? "",
      operatorPrivateKey: required("HEDERA_OPERATOR_PRIVATE_KEY"),
    }
    : auditMode === "noop" ? { mode: "noop" } : undefined;

  if (
    invalid.length > 0 || host === undefined || listenPort === undefined || borrowerAccountId === undefined
    || mirrorNodeUrl === undefined || signerUrl === undefined || registrarUrl === undefined
    || providerCallbackSecrets === undefined || proofMode === undefined || alwaysBorrow === undefined || audit === undefined
  ) {
    throw new EnvironmentValidationError([...new Set(invalid)].sort());
  }

  return Object.freeze({
    host,
    port: listenPort,
    databasePath,
    borrowerAccountId,
    mirrorNodeUrl,
    signerUrl,
    consumerCredential,
    orchestratorCredential,
    registrarUrl,
    lenders,
    providerCallbackSecrets: Object.freeze(providerCallbackSecrets),
    proofMode,
    alwaysBorrow,
    audit,
  });
}

export interface OrchestratorRuntime {
  readonly host: string;
  readonly port: number;
  readonly database: KovenDatabase;
  readonly audit: OrchestratorAuditRuntime;
  listen(): Promise<Server>;
  close(): void;
}

export interface OrchestratorRuntimeOptions {
  /** Test seam: replaces the Hedera-backed HCS publisher in `hcs` mode. */
  readonly publisher?: HcsPublisher;
}

/**
 * Composes the mission orchestrator exactly as the end-to-end runs do: the
 * keyless consumer over the remote signer and lenders, the registrar for
 * provider selection and policy provisioning, the trusted completion callback
 * with independent Mirror Node confirmation, the repayment workflow, and the
 * durable audit outbox.
 */
export function createOrchestratorRuntime(
  config: OrchestratorConfig,
  options: OrchestratorRuntimeOptions = {},
): OrchestratorRuntime {
  const database = openDatabase(config.databasePath);
  let auditClient: Client | undefined;
  let audit: OrchestratorAuditRuntime | undefined;
  try {
    let publisher = options.publisher;
    if (config.audit.mode === "hcs" && publisher === undefined) {
      auditClient = createClient({
        HEDERA_NETWORK: "testnet",
        HEDERA_OPERATOR_ID: config.audit.operatorId,
        HEDERA_OPERATOR_PRIVATE_KEY: config.audit.operatorPrivateKey,
      });
      publisher = new HederaHcsPublisher(auditClient, config.audit.topicId);
    }
    audit = createOrchestratorAuditRuntime({
      database,
      mode: config.audit.mode,
      ...(publisher === undefined ? {} : { publisher }),
    });
    const stateMachine = new MissionStateMachine(database, audit.sink);
    const consumer = new ConsumerMissionExecutor({
      borrowerAccountId: config.borrowerAccountId,
      balance: config.alwaysBorrow ? emptyBalanceReader : new MirrorBalanceReader({ mirrorNodeUrl: config.mirrorNodeUrl }),
      signer: new HttpCreditSigner({ baseUrl: config.signerUrl, credential: config.consumerCredential }),
      lenders: config.lenders.map(lender => new HttpLender({
        baseUrl: lender.baseUrl,
        publicKey: PublicKey.fromStringECDSA(lender.publicKey),
      })),
      payment: new ConsumerPaymentService({
        borrowerAccountId: config.borrowerAccountId,
        authorizer: createHttpPaymentAuthorizer({ baseUrl: config.signerUrl, credential: config.consumerCredential }),
        ...(config.proofMode === "zk" ? { prover: new ZkPolicyProver() } : {}),
      }),
    });
    const workflow = new MissionWorkflow({
      database,
      stateMachine,
      consumer,
      policyRegistrars: [new HttpMissionPolicyRegistrar({ baseUrl: config.registrarUrl, credential: config.orchestratorCredential })],
      providerDirectory: new HttpProviderDirectory({ baseUrl: config.registrarUrl, credential: config.orchestratorCredential }),
      borrowerAccountId: config.borrowerAccountId,
    });
    const app = createOrchestratorApp({
      database,
      workflow,
      completionHandler: new CompletionHandler({
        database,
        stateMachine,
        providerCallbackSecrets: config.providerCallbackSecrets,
        settlementConfirmer: new MirrorTransferConfirmer({ mirrorNodeUrl: config.mirrorNodeUrl }),
        signerCompletion: new HttpSignerCompletionClient({ baseUrl: config.signerUrl }),
      }),
      repaymentWorkflow: new RepaymentWorkflow({
        database,
        stateMachine,
        client: new HttpRepaymentClient({ baseUrl: config.signerUrl, credential: config.orchestratorCredential }),
      }),
    });
    const auditRuntime = audit;
    const close = (): void => {
      auditRuntime.stop();
      try {
        if (database.open) database.close();
      } finally {
        auditClient?.close();
      }
    };
    return {
      host: config.host,
      port: config.port,
      database,
      audit: auditRuntime,
      listen: () => new Promise<Server>((resolve, reject) => {
        const server = app.listen(config.port, config.host, () => {
          // Pending attestations of earlier runs resume as soon as the process serves again.
          auditRuntime.start();
          resolve(server);
        });
        server.once("error", reject);
      }),
      close,
    };
  } catch (error) {
    audit?.stop();
    try {
      if (database.open) database.close();
    } finally {
      auditClient?.close();
    }
    throw error;
  }
}
