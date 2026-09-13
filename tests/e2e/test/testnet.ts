import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ConsumerMissionExecutor,
  ConsumerPaymentService,
  HttpCreditSigner,
  HttpLender,
  ZkPolicyProver,
} from "@koven/consumer-agent";
import { HederaHcsPublisher } from "@koven/audit";
import { createDirectoryApp, createRegistrarApp, HttpMissionPolicyTarget, ProviderRegistry } from "@koven/directory";
import type { Provider } from "@koven/domain";
import { createClient, explorerUrl, getBalanceTinybar, PrivateKey } from "@koven/hedera";
import {
  AgentKitFundingGateway,
  ConservativeLenderPolicy,
  CompetitiveLenderPolicy,
  createLenderApp,
  FundingService,
  HttpLoanRegistrationClient,
  LenderProofVerifier,
  LenderStore,
  loadLenderVerification,
  MirrorNodeFundingReconciler,
} from "@koven/lender-agents";
import {
  CompletionHandler,
  createOrchestratorAuditRuntime,
  createOrchestratorApp,
  HttpMissionPolicyRegistrar,
  HttpProviderDirectory,
  HttpRepaymentClient,
  HttpSignerCompletionClient,
  MissionStateMachine,
  MissionWorkflow,
  RepaymentWorkflow,
  type OrchestratorAuditRuntime,
} from "@koven/orchestrator";
import {
  createEvent,
  getLoanByMission,
  getMission,
  getMissionCompletion,
  listMissionEvents,
  openDatabase,
  type KovenDatabase,
} from "@koven/persistence";
import {
  callbackSignature,
  CallbackDispatcher,
  createPaidScanServer,
  MirrorSettlementConfirmer,
  ProviderStore,
  type PaidScanServer,
} from "@koven/resource-server";
import {
  createSignerRuntime,
  MirrorTransferConfirmer,
  type SignerRuntime,
} from "@koven/restricted-signer";
import { CallbackResponseSchema, MissionSchema } from "@koven/schemas";
import { createHttpPaymentAuthorizer, loadPoseidon } from "@koven/x402";

import { injectCompetitionFailures } from "./competition-history.js";

const env = process.env;

const required = (key: string): string => {
  const value = env[key];
  if (!value) throw new Error(`Missing ${key} in .env`);
  return value;
};

const port = (key: string): number => {
  const value = Number(required(key));
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${key} must be an integer between 1 and 65535`);
  }
  return value;
};

const credential = (): string => randomBytes(32).toString("base64url");

const privateKey = (value: string, label: string): PrivateKey => {
  try {
    return PrivateKey.fromStringECDSA(value);
  } catch {
    throw new Error(`${label} must be a valid ECDSA private key`);
  }
};

const closeServer = (server: Server | undefined): Promise<void> => new Promise((resolveClose, reject) => {
  if (server === undefined || !server.listening) {
    resolveClose();
    return;
  }
  server.close(error => error === undefined ? resolveClose() : reject(error));
});

const listen = async (server: Server): Promise<void> => {
  await new Promise<void>((resolveListen, reject) => {
    server.once("listening", resolveListen);
    server.once("error", reject);
  });
};

const waitUntil = async (condition: () => boolean, timeoutMs: number, detail: string): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  if (!condition()) throw new Error(detail);
};

async function runTestnet(selected: "A" | "B", history: KovenDatabase): Promise<void> {
const extraServers: Server[] = [];
const extraDatabases: KovenDatabase[] = [];
let otherPaidScan: PaidScanServer | undefined;
let otherLenderClient: ReturnType<typeof createClient> | undefined;
let registrarUrl = "";
const otherName = selected === "A" ? "B" : "A";
const otherProviderAccountId = required(`PROVIDER_${otherName}_ACCOUNT_ID`);
const otherLenderAccountId = required("LENDER_B_ACCOUNT_ID");
const otherLenderKeyText = required("LENDER_B_PRIVATE_KEY");
const otherLenderKey = privateKey(otherLenderKeyText, "Second lender key");
const otherLenderPort = port("LENDER_B_PORT");
const otherProviderPort = port(`PROVIDER_${otherName}_PORT`);
const directoryPort = port("DIRECTORY_PORT");
const registrarPort = port("REGISTRAR_PORT");
const otherLenderUrl = `http://127.0.0.1:${otherLenderPort}`;
const otherProviderUrl = `http://127.0.0.1:${otherProviderPort}`;
const otherLenderCredential = credential();
const otherLenderOperatorCredential = credential();
const approvalCredential = credential();
const consumerAccountId = required("CONSUMER_ACCOUNT_ID");
const consumerPrivateKey = required("CONSUMER_PRIVATE_KEY");
const lenderAccountId = required("LENDER_A_ACCOUNT_ID");
const lenderPrivateKeyText = required("LENDER_A_PRIVATE_KEY");
const providerAccountId = required(`PROVIDER_${selected}_ACCOUNT_ID`);
const mirrorNodeUrl = required("HEDERA_MIRROR_NODE_URL");
const facilitatorUrl = required("X402_FACILITATOR_URL");
const signerPort = port("RESTRICTED_SIGNER_PORT");
const providerPort = port(`PROVIDER_${selected}_PORT`);
const orchestratorPort = port("ORCHESTRATOR_PORT");
const lenderPort = port("LENDER_A_PORT");
if (new Set([signerPort, providerPort, orchestratorPort, lenderPort, otherLenderPort, otherProviderPort, directoryPort, registrarPort]).size !== 8) {
  throw new Error("Local service ports must be distinct");
}

const priceTinybar = BigInt(required(`PROVIDER_${selected}_PRICE_TINYBAR`));
const otherPriceTinybar = BigInt(required(`PROVIDER_${otherName}_PRICE_TINYBAR`));
const spendingCapTinybar = BigInt(env.DEFAULT_MISSION_SPENDING_CAP || priceTinybar.toString(10));
if (priceTinybar <= 0n) throw new Error("Provider price must be positive");
if (spendingCapTinybar < priceTinybar || spendingCapTinybar < otherPriceTinybar) throw new Error("Mission spending cap must cover the provider price");
// The signer's deployment setting; in zk mode the consumer proves every payment with the official artifacts.
const proofModeSetting = env.SIGNER_PROOF_MODE || "deterministic";
if (proofModeSetting !== "deterministic" && proofModeSetting !== "zk") throw new Error("SIGNER_PROOF_MODE must be deterministic or zk");
const proofMode: "deterministic" | "zk" = proofModeSetting;

const runId = `${new Date().toISOString().replaceAll(":", "-")}-${randomBytes(4).toString("hex")}`;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
// The lender pins its own key in the same mode; a run never mixes proof modes across services.
const lenderVerification = proofMode === "zk"
  ? loadLenderVerification({
    LENDER_PROOF_MODE: "zk",
    LENDER_VERIFICATION_KEY_PATH: resolve(repositoryRoot, required("LENDER_VERIFICATION_KEY_PATH")),
    LENDER_TRUSTED_VKEY_SHA256: required("LENDER_TRUSTED_VKEY_SHA256"),
  })
  : { proofMode, trusted: undefined };
const resumeDirectory = env.KOVEN_TESTNET_RESUME_DIRECTORY?.trim();
const runDirectory = resumeDirectory
  ? resolve(repositoryRoot, resumeDirectory)
  : resolve(repositoryRoot, env.KOVEN_TESTNET_RUN_DIR || ".koven-testnet", runId);
const callbackSecret = randomBytes(32);
const callbackSecretText = callbackSecret.toString("base64url");
const consumerCredential = credential();
const orchestratorCredential = credential();
const registrarCredential = credential();
const lenderCredential = credential();
const lenderOperatorCredential = credential();
const consumerKey = privateKey(consumerPrivateKey, "Consumer key");
const lenderKey = privateKey(lenderPrivateKeyText, "Lender key");
const signerUrl = `http://127.0.0.1:${signerPort}`;
const providerUrl = `http://127.0.0.1:${providerPort}`;
const lenderUrl = `http://127.0.0.1:${lenderPort}`;
const orchestratorUrl = `http://127.0.0.1:${orchestratorPort}`;
const provider: Provider = {
  id: `provider-${selected.toLowerCase()}`,
  accountId: providerAccountId,
  endpoint: providerUrl,
  capability: "solidity-scan",
  priceTinybar,
  reputationScore: 0.9,
  expectedLatencyMs: Number(required(`PROVIDER_${selected}_LATENCY_MS`)),
};

const otherProvider: Provider = { ...provider, id: `provider-${otherName.toLowerCase()}`, accountId: otherProviderAccountId,
  endpoint: otherProviderUrl, priceTinybar: otherPriceTinybar, expectedLatencyMs: Number(required(`PROVIDER_${otherName}_LATENCY_MS`)) };
const missionIdForRun = `mission-${runId}`;
const missionRequest = { prompt: "Audit the Solidity contract", maxBudgetTinybar: spendingCapTinybar.toString(), targetRef: "Vault.sol",
  source: "pragma solidity ^0.8.24; contract Vault { function value() external pure returns (uint256) { return 1; } }" };
let signerRuntime: SignerRuntime | undefined;
let paidScan: PaidScanServer | undefined;
let signerServer: Server | undefined;
let lenderServer: Server | undefined;
let providerServer: Server | undefined;
let orchestratorServer: Server | undefined;
let lenderDatabase: KovenDatabase | undefined;
let orchestratorDatabase: KovenDatabase | undefined;
let orchestratorAudit: OrchestratorAuditRuntime | undefined;
let providerStore: ProviderStore | undefined;
let lenderClient: ReturnType<typeof createClient> | undefined;
const auditMode = env.AUDIT_SINK ?? "hcs";
if (auditMode !== "noop" && auditMode !== "hcs") throw new Error("AUDIT_SINK must be noop or hcs");
const auditClient = auditMode === "hcs"
  ? createClient({
    HEDERA_NETWORK: "testnet",
    HEDERA_OPERATOR_ID: required("HEDERA_OPERATOR_ID"),
    HEDERA_OPERATOR_PRIVATE_KEY: required("HEDERA_OPERATOR_PRIVATE_KEY"),
  })
  : undefined;
const flushOrchestratorAudit = async (): Promise<void> => {
  if (orchestratorAudit !== undefined) await orchestratorAudit.flush(60_000);
};

try {
  if (resumeDirectory) {
    await Promise.all(["signer.db", "orchestrator.db", "provider.db"].map(file => access(resolve(runDirectory, file))));
  } else {
    await mkdir(runDirectory, { recursive: true });
    await writeFile(resolve(runDirectory, "selection.json"), JSON.stringify({ selected }));
    otherLenderClient = createClient({ HEDERA_NETWORK: "testnet", HEDERA_OPERATOR_ID: otherLenderAccountId, HEDERA_OPERATOR_PRIVATE_KEY: otherLenderKeyText });
    lenderClient = createClient({
      HEDERA_NETWORK: "testnet",
      HEDERA_OPERATOR_ID: lenderAccountId,
      HEDERA_OPERATOR_PRIVATE_KEY: lenderPrivateKeyText,
    });
    const repaymentFeeTinybar = (priceTinybar * 100n + 9_999n) / 10_000n;
    const feeReserveTinybar = BigInt(env.KOVEN_TESTNET_FEE_RESERVE_TINYBAR || "1000000");
    if (feeReserveTinybar < 0n) throw new Error("Testnet fee reserve cannot be negative");
    const [consumerBalance, lenderBalance] = await Promise.all([
      getBalanceTinybar(lenderClient, consumerAccountId),
      getBalanceTinybar(lenderClient, lenderAccountId),
    ]);
    if (consumerBalance < priceTinybar + repaymentFeeTinybar + feeReserveTinybar) {
      throw new Error("Consumer testnet balance is too low for repayment and network fees");
    }
    if (await getBalanceTinybar(otherLenderClient!, otherLenderAccountId) < spendingCapTinybar + feeReserveTinybar) throw new Error("Second lender balance is too low");
    if (lenderBalance < priceTinybar + feeReserveTinybar) {
      throw new Error("Lender testnet balance is too low for funding and network fees");
    }
  }
  process.stdout.write(`${resumeDirectory ? "Resuming" : "Starting"} testnet run in ${runDirectory}\n`);

  signerRuntime = await createSignerRuntime({
    HEDERA_NETWORK: "testnet",
    HEDERA_MIRROR_NODE_URL: mirrorNodeUrl,
    X402_NETWORK: "hedera:testnet",
    CONSUMER_ACCOUNT_ID: consumerAccountId,
    CONSUMER_PRIVATE_KEY: consumerPrivateKey,
    RESTRICTED_SIGNER_PORT: String(signerPort),
    RESTRICTED_SIGNER_HOST: "127.0.0.1",
    DATABASE_URL: resolve(runDirectory, "signer.db"),
    DEFAULT_MISSION_SPENDING_CAP: spendingCapTinybar.toString(10),
    SIGNER_PROOF_MODE: proofMode,
    ...(proofMode === "zk" ? {
      SIGNER_VERIFICATION_KEY_PATH: resolve(repositoryRoot, required("SIGNER_VERIFICATION_KEY_PATH")),
      SIGNER_TRUSTED_VKEY_SHA256: required("SIGNER_TRUSTED_VKEY_SHA256"),
    } : {}),
    SIGNER_CONSUMER_CREDENTIAL: consumerCredential,
    SIGNER_ORCHESTRATOR_CREDENTIAL: orchestratorCredential,
    SIGNER_REGISTRAR_CREDENTIAL: registrarCredential,
    SIGNER_LENDER_CREDENTIALS: `${lenderAccountId}:${lenderCredential};${otherLenderAccountId}:${otherLenderCredential}`,
    SIGNER_LENDER_PUBLIC_KEYS: `${lenderAccountId}:${lenderKey.publicKey.toStringRaw()};${otherLenderAccountId}:${otherLenderKey.publicKey.toStringRaw()}`,
    SIGNER_PROVIDER_CALLBACK_SECRETS: `${provider.id}:${callbackSecretText}`,
  });
  signerServer = await signerRuntime.listen();

  if (!resumeDirectory) {
    lenderDatabase = openDatabase(resolve(runDirectory, "lender.db"));
    const lenderStore = new LenderStore(lenderDatabase);
    const fundingService = new FundingService({
      store: lenderStore,
      gateway: new AgentKitFundingGateway(
        lenderClient!,
        lenderAccountId,
        new MirrorNodeFundingReconciler(mirrorNodeUrl),
        required("HCS_AUDIT_TOPIC_ID"),
      ),
      registrationClient: new HttpLoanRegistrationClient(signerUrl, lenderCredential),
      lenderAccountId,
    });
    lenderServer = createLenderApp({
      store: lenderStore,
      policy: new ConservativeLenderPolicy({
        maxPrincipalTinybar: spendingCapTinybar,
        maxTermSeconds: 3_600,
        minReputationScore: 0,
        feeBps: 100,
      }),
      fundingService,
      lenderAccountId,
      lenderPrivateKey: lenderKey,
      operatorCredential: lenderOperatorCredential,
      borrowerPublicKey: accountId => accountId === consumerAccountId ? consumerKey.publicKey : undefined,
      borrowerReputation: () => 1,
      proofMode: lenderVerification.proofMode,
      ...(lenderVerification.trusted === undefined ? {} : {
        proofVerifier: new LenderProofVerifier({ poseidon: await loadPoseidon(), trusted: lenderVerification.trusted }),
      }),
    }).listen(lenderPort, "127.0.0.1");
    await listen(lenderServer);
    {
    const otherLenderDatabase = openDatabase(resolve(runDirectory, "lender-b.db"));
    const lenderStore = new LenderStore(otherLenderDatabase);
    const fundingService = new FundingService({
      store: lenderStore,
      gateway: new AgentKitFundingGateway(
        otherLenderClient!,
        otherLenderAccountId,
        new MirrorNodeFundingReconciler(mirrorNodeUrl),
        required("HCS_AUDIT_TOPIC_ID"),
      ),
      registrationClient: new HttpLoanRegistrationClient(signerUrl, otherLenderCredential),
      lenderAccountId: otherLenderAccountId,
    });
    const otherLenderServer = createLenderApp({
      store: lenderStore,
      policy: new CompetitiveLenderPolicy({
        maxPrincipalTinybar: spendingCapTinybar,
        maxTermSeconds: 3_600,
        minReputationScore: 0,
        feeBps: 200,
      }),
      fundingService,
      lenderAccountId: otherLenderAccountId,
      lenderPrivateKey: otherLenderKey,
      operatorCredential: otherLenderOperatorCredential,
      borrowerPublicKey: accountId => accountId === consumerAccountId ? consumerKey.publicKey : undefined,
      borrowerReputation: () => 1,
      proofMode: lenderVerification.proofMode,
      ...(lenderVerification.trusted === undefined ? {} : {
        proofVerifier: new LenderProofVerifier({ poseidon: await loadPoseidon(), trusted: lenderVerification.trusted }),
      }),
    }).listen(otherLenderPort, "127.0.0.1");
    extraServers.push(otherLenderServer);
    extraDatabases.push(otherLenderDatabase);
    await listen(otherLenderServer);
    }
  }

  const repaymentClient = new HttpRepaymentClient({
    baseUrl: signerUrl,
    credential: orchestratorCredential,
  });
  const createOrchestrator = (database: KovenDatabase) => {
    orchestratorAudit = createOrchestratorAuditRuntime({
      database,
      mode: auditMode,
      ...(auditMode === "hcs" ? {
        publisher: new HederaHcsPublisher(auditClient!, required("HCS_AUDIT_TOPIC_ID")),
      } : {}),
    });
    orchestratorAudit.start();
    const stateMachine = new MissionStateMachine(database, orchestratorAudit.sink);
    const consumer = new ConsumerMissionExecutor({
      borrowerAccountId: consumerAccountId,
      // Exercise credit deliberately; the balance preflight above reserves repayment funds.
      balance: { getBalanceTinybar: async () => 0n },
      signer: new HttpCreditSigner({ baseUrl: signerUrl, credential: consumerCredential }),
      lenders: [new HttpLender({ baseUrl: lenderUrl, publicKey: lenderKey.publicKey }), new HttpLender({ baseUrl: otherLenderUrl, publicKey: otherLenderKey.publicKey })],
      payment: new ConsumerPaymentService({
        borrowerAccountId: consumerAccountId,
        authorizer: createHttpPaymentAuthorizer({ baseUrl: signerUrl, credential: consumerCredential }),
        ...(proofMode === "zk" ? { prover: new ZkPolicyProver() } : {}),
      }),
    });
    const workflow = new MissionWorkflow({
      database,
      stateMachine,
      consumer,
      policyRegistrars: [new HttpMissionPolicyRegistrar({ baseUrl: registrarUrl, credential: orchestratorCredential })],
      providerDirectory: new HttpProviderDirectory({ baseUrl: registrarUrl, credential: orchestratorCredential }),
      missionId: () => missionIdForRun,
      borrowerAccountId: consumerAccountId,
    });
    return createOrchestratorApp({
      database,
      workflow,
      completionHandler: new CompletionHandler({
        database,
        stateMachine,
        providerCallbackSecrets: { [provider.id]: callbackSecret },
        settlementConfirmer: new MirrorTransferConfirmer({ mirrorNodeUrl }),
        signerCompletion: new HttpSignerCompletionClient({ baseUrl: signerUrl }),
      }),
      repaymentWorkflow: new RepaymentWorkflow({ database, stateMachine, client: repaymentClient }),
    });
  };

  const registry = new ProviderRegistry([provider, otherProvider].map(({ reputationScore: _score, ...record }) => ({ ...record, priceTinybar: record.priceTinybar.toString() })));
  const directoryServer = createDirectoryApp({ database: history, registry }).listen(directoryPort, "127.0.0.1");
  extraServers.push(directoryServer);
  await listen(directoryServer);
  if (!resumeDirectory) {
    const ranking = await new HttpProviderDirectory({ baseUrl: `http://127.0.0.1:${directoryPort}` }).rank({ capability: "solidity-scan", maxPriceTinybar: spendingCapTinybar.toString() });
    if (ranking.ranked[0]?.provider.id !== provider.id) throw new Error("Configured price/latency does not produce the expected competition winner");
  }
  const registrarDatabase = openDatabase(resolve(runDirectory, "registrar.db"));
  extraDatabases.push(registrarDatabase);
  const registrar = await createRegistrarApp({ database: registrarDatabase, eventDatabase: history, registry, borrowerAccountId: consumerAccountId,
    operatorCredential: approvalCredential, orchestratorCredential,
    targets: [new HttpMissionPolicyTarget({ baseUrl: signerUrl, credential: registrarCredential }),
      new HttpMissionPolicyTarget({ baseUrl: lenderUrl, credential: lenderOperatorCredential }),
      new HttpMissionPolicyTarget({ baseUrl: otherLenderUrl, credential: otherLenderOperatorCredential })],
  });
  const registrarServer = registrar.listen(registrarPort, "127.0.0.1");
  extraServers.push(registrarServer);
  await listen(registrarServer);
  registrarUrl = `http://127.0.0.1:${registrarPort}`;
  if (!resumeDirectory) {
    const approved = await fetch(`${registrarUrl}/missions/approve`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${approvalCredential}` },
      body: JSON.stringify({ missionId: missionIdForRun, request: missionRequest }) });
    if (approved.status !== 200) throw new Error("Operator approval failed");
  }

  orchestratorDatabase = openDatabase(resolve(runDirectory, "orchestrator.db"));
  orchestratorServer = createOrchestrator(orchestratorDatabase).listen(orchestratorPort, "127.0.0.1");
  await listen(orchestratorServer);

  let loseFirstCallbackResponse = true;
  const lossyCallbackFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (loseFirstCallbackResponse && response.status === 202) {
      loseFirstCallbackResponse = false;
      await response.arrayBuffer();
      throw new TypeError("Injected lost callback response");
    }
    return response;
  };
  providerStore = new ProviderStore(resolve(runDirectory, "provider.db"));
  paidScan = await createPaidScanServer({
    providerId: provider.id,
    providerAccountId,
    scanUrl: `${providerUrl}/scan`,
    amountTinybar: priceTinybar.toString(10),
    expectedLatencyMs: provider.expectedLatencyMs,
    network: "hedera:testnet",
    asset: "0.0.0",
    signerPublicKeys: { [consumerAccountId]: consumerKey.publicKey.toStringRaw() },
    facilitatorUrl,
    store: providerStore,
    settlementConfirmer: new MirrorSettlementConfirmer({ mirrorNodeUrl }),
    callbackUrl: `${orchestratorUrl}/callbacks/mission-complete`,
    callbackSecret,
    callbackFetch: lossyCallbackFetch,
    callbackRandom: () => 0,
    dispatchCallbacks: false,
  });
  providerServer = paidScan.app.listen(providerPort, "127.0.0.1");
  await listen(providerServer);
  const otherProviderStore = new ProviderStore(resolve(runDirectory, "other-provider.db"));
  otherPaidScan = await createPaidScanServer({
    providerId: otherProvider.id,
    providerAccountId: otherProviderAccountId,
    scanUrl: `${otherProviderUrl}/scan`,
    amountTinybar: otherPriceTinybar.toString(10),
    expectedLatencyMs: otherProvider.expectedLatencyMs,
    network: "hedera:testnet",
    asset: "0.0.0",
    signerPublicKeys: { [consumerAccountId]: consumerKey.publicKey.toStringRaw() },
    facilitatorUrl,
    store: otherProviderStore,
    settlementConfirmer: new MirrorSettlementConfirmer({ mirrorNodeUrl }),
    callbackUrl: `${orchestratorUrl}/callbacks/mission-complete`,
    callbackSecret,

    callbackRandom: () => 0,
    dispatchCallbacks: false,
  });
  const otherProviderServer = otherPaidScan.app.listen(otherProviderPort, "127.0.0.1");
  extraServers.push(otherProviderServer);
  extraDatabases.push(otherProviderStore.database);
  await listen(otherProviderServer);

  run: {
  let missionId: string;
  if (resumeDirectory) {
    const rows = orchestratorDatabase.prepare(`
      SELECT id, state FROM missions ORDER BY created_at
    `).all() as { id: string; state: string }[];
    if (rows.length !== 1
      || !["running", "completed", "repayment-pending", "repaid", "closed"].includes(rows[0]!.state)) {
      throw new Error("Resume directory must contain exactly one recoverable mission");
    }
    missionId = rows[0]!.id;
  } else {
    const createdResponse = await fetch(`${orchestratorUrl}/missions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "Audit the Solidity contract",
        maxBudgetTinybar: spendingCapTinybar.toString(10),
        targetRef: "Vault.sol",
        source: "pragma solidity ^0.8.24; contract Vault { function value() external pure returns (uint256) { return 1; } }",
      }),
    });
    if (createdResponse.status !== 201) {
      throw new Error(`Mission creation returned HTTP ${createdResponse.status}: ${await createdResponse.text()}`);
    }
    const created = MissionSchema.parse(await createdResponse.json());
    if (created.state !== "running") throw new Error(`Mission stopped before callback in state ${created.state}`);
    missionId = created.id;
    const offers = listMissionEvents<{ ranked: unknown[] }>(orchestratorDatabase, missionId).find(event => event.type === "offers-received");
    if (offers?.payload.ranked.length !== 2) throw new Error("Both real lenders must return verified ranked offers");

  }

  const reportEvent = listMissionEvents(orchestratorDatabase, missionId).find(event => event.type === "report-received");
  if (reportEvent === undefined) throw new Error("Provider success evidence is missing");
  createEvent(history, reportEvent);
  await writeFile(resolve(runDirectory, "competition-history.json"), JSON.stringify(history.prepare("SELECT type, payload_json, occurred_at FROM events ORDER BY seq").all(), null, 2));

  if (getMission(orchestratorDatabase, missionId)?.state === "closed") {
    const callback = providerStore.database.prepare(`
      SELECT idempotency_key, body FROM provider_callback_jobs WHERE status = 'delivered'
    `).get() as { idempotency_key: string; body: string } | undefined;
    const loanBeforeReplay = getLoanByMission(orchestratorDatabase, missionId);
    if (!callback || !loanBeforeReplay?.fundingTxId || !loanBeforeReplay.repaymentTxId) {
      throw new Error("Closed resume run has no delivered callback or repayment evidence");
    }
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const replay = await fetch(`${orchestratorUrl}/callbacks/mission-complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": callback.idempotency_key,
        "x-callback-timestamp": timestamp,
        "x-callback-signature": callbackSignature(
          callbackSecret,
          timestamp,
          callback.idempotency_key,
          callback.body,
        ),
      },
      body: callback.body,
    });
    const acknowledgement = CallbackResponseSchema.parse(await replay.json());
    const loan = getLoanByMission(orchestratorDatabase, missionId);
    const completion = getMissionCompletion(orchestratorDatabase, missionId);
    if (replay.status !== 202
      || acknowledgement.status !== "duplicate"
      || !loan?.fundingTxId
      || loan?.repaymentTxId !== loanBeforeReplay.repaymentTxId
      || !completion) {
      throw new Error("Closed mission replay did not preserve the existing repayment");
    }
    await flushOrchestratorAudit();
    process.stdout.write(`${JSON.stringify({
      missionId,
      state: "closed",
      recovery: "callback replayed after restart without a second repayment",
      transactions: {
        funding: { id: loan.fundingTxId, hashscan: explorerUrl(loan.fundingTxId) },
        payment: { id: completion.settlementTxId, hashscan: explorerUrl(completion.settlementTxId) },
        repayment: { id: loan.repaymentTxId, hashscan: explorerUrl(loan.repaymentTxId) },
      },
      databases: runDirectory,
    }, null, 2)}\n`);
    break run;
  }

  const callbackDeadline = Date.now() + 180_000;
  while (loseFirstCallbackResponse && Date.now() < callbackDeadline) {
    await paidScan.settlements.dispatchDue();
    await paidScan.callbacks.dispatchDue(1);
    if (loseFirstCallbackResponse) await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  if (loseFirstCallbackResponse) {
    throw new Error("No accepted callback response became available before the timeout");
  }
  await waitUntil(
    () => getMission(orchestratorDatabase!, missionId)?.state === "closed",
    180_000,
    "Mission did not close after the first callback",
  );
  const firstLoan = getLoanByMission(orchestratorDatabase, missionId);
  if (!firstLoan?.repaymentTxId) throw new Error("Repayment transaction was not persisted");
  const repaymentTxId = firstLoan.repaymentTxId;

  await closeServer(orchestratorServer);
  orchestratorServer = undefined;
  orchestratorAudit?.stop();
  orchestratorAudit = undefined;
  orchestratorDatabase.close();
  orchestratorDatabase = openDatabase(resolve(runDirectory, "orchestrator.db"));
  orchestratorServer = createOrchestrator(orchestratorDatabase).listen(orchestratorPort, "127.0.0.1");
  await listen(orchestratorServer);

  paidScan.callbacks.stop();
  paidScan.settlements.stop();
  await closeServer(providerServer);
  providerServer = undefined;
  providerStore.close();
  providerStore = new ProviderStore(resolve(runDirectory, "provider.db"));
  const replayResponses: ReturnType<typeof CallbackResponseSchema.parse>[] = [];
  const replayDispatcher = new CallbackDispatcher({
    store: providerStore,
    callbackUrl: `${orchestratorUrl}/callbacks/mission-complete`,
    callbackSecret,
    random: () => 0,
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      replayResponses.push(CallbackResponseSchema.parse(await response.clone().json()));
      return response;
    },
  });
  for (let attempt = 0; attempt < 3 && replayResponses.length === 0; attempt += 1) {
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
    if (await replayDispatcher.dispatchDue() !== 1) {
      throw new Error("Persisted callback was not replayed after restart");
    }
  }
  if (replayResponses.length !== 1
    || replayResponses[0]?.status !== "duplicate"
    || replayResponses[0].code !== "callback_duplicate") {
    throw new Error("Callback replay did not return the persisted duplicate acknowledgement");
  }

  const mission = getMission(orchestratorDatabase, missionId);
  const loan = getLoanByMission(orchestratorDatabase, missionId);
  const completion = getMissionCompletion(orchestratorDatabase, missionId);
  if (mission?.state !== "closed" || !loan?.fundingTxId || loan.repaymentTxId !== repaymentTxId || !completion) {
    throw new Error(`Vertical testnet flow did not remain closed; final state is ${mission?.state ?? "missing"}`);
  }
  const eventTypes = listMissionEvents(orchestratorDatabase, missionId).map(event => event.type);
  if (!eventTypes.includes("callback-duplicate")) {
    throw new Error("Duplicate callback audit evidence is missing");
  }
  if (eventTypes.includes("proof-generated") !== (proofMode === "zk")) {
    throw new Error(`Proof audit evidence does not match the ${proofMode} signer mode`);
  }

  await flushOrchestratorAudit();
  process.stdout.write(`${JSON.stringify({
    missionId,
    state: mission.state,
    proofMode,
    recovery: "lost callback response replayed after restart without a second repayment",
    transactions: {
      funding: { id: loan.fundingTxId, hashscan: explorerUrl(loan.fundingTxId) },
      payment: { id: completion.settlementTxId, hashscan: explorerUrl(completion.settlementTxId) },
      repayment: { id: loan.repaymentTxId, hashscan: explorerUrl(loan.repaymentTxId) },
    },
    databases: runDirectory,
  }, null, 2)}\n`);
  }
} finally {
  orchestratorAudit?.stop();
  paidScan?.callbacks.stop();
  paidScan?.settlements.stop();
  otherPaidScan?.callbacks.stop();
  otherPaidScan?.settlements.stop();
  await Promise.allSettled([
    ...extraServers.map(closeServer),
    closeServer(providerServer),
    closeServer(orchestratorServer),
    closeServer(lenderServer),
    closeServer(signerServer),
  ]);
  if (providerStore?.database.open) providerStore.close();
  if (orchestratorDatabase?.open) orchestratorDatabase.close();
  if (lenderDatabase?.open) lenderDatabase.close();
  extraDatabases.forEach(database => { if (database.open) database.close(); });
  otherLenderClient?.close();
  lenderClient?.close();
  auditClient?.close();
  signerRuntime?.close();
}

}
const history = openDatabase(":memory:");
const continueCompetition = env.KOVEN_TESTNET_CONTINUE_COMPETITION === "1";

try {
  if (env.KOVEN_TESTNET_RESUME_DIRECTORY) {
    const metadata = JSON.parse(await readFile(resolve(fileURLToPath(new URL("../../../", import.meta.url)), env.KOVEN_TESTNET_RESUME_DIRECTORY, "selection.json"), "utf8")) as { selected: "A" | "B" };
    if (metadata.selected !== "A" && metadata.selected !== "B") throw new Error("Invalid resume provider");
    if (continueCompetition && metadata.selected !== "B") throw new Error("Competition continuation requires the completed provider B mission");
    await runTestnet(metadata.selected, history);
    if (continueCompetition) {
      delete env.KOVEN_TESTNET_RESUME_DIRECTORY;
      injectCompetitionFailures(history, "provider-b");
      await runTestnet("A", history);
    }
  } else {
    if (continueCompetition) throw new Error("Competition continuation requires a resume directory");
    await runTestnet("B", history);
    injectCompetitionFailures(history, "provider-b");
    await runTestnet("A", history);
  }
} finally { history.close(); }
