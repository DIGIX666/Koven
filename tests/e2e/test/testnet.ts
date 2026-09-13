import { randomBytes } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ConsumerMissionExecutor,
  ConsumerPaymentService,
  HttpCreditSigner,
  HttpLender,
} from "@koven/consumer-agent";
import type { Provider } from "@koven/domain";
import { createClient, explorerUrl, getBalanceTinybar, PrivateKey } from "@koven/hedera";
import {
  AgentKitFundingGateway,
  ConservativeLenderPolicy,
  createLenderApp,
  FundingService,
  HttpLoanRegistrationClient,
  LenderStore,
  MirrorNodeFundingReconciler,
} from "@koven/lender-agents";
import {
  CompletionHandler,
  createOrchestratorApp,
  HttpMissionPolicyRegistrar,
  HttpRepaymentClient,
  HttpSignerCompletionClient,
  MissionStateMachine,
  MissionWorkflow,
  RepaymentWorkflow,
} from "@koven/orchestrator";
import {
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
import { createHttpPaymentAuthorizer } from "@koven/x402";

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

const consumerAccountId = required("CONSUMER_ACCOUNT_ID");
const consumerPrivateKey = required("CONSUMER_PRIVATE_KEY");
const lenderAccountId = required("LENDER_A_ACCOUNT_ID");
const lenderPrivateKeyText = required("LENDER_A_PRIVATE_KEY");
const providerAccountId = required("PROVIDER_A_ACCOUNT_ID");
const mirrorNodeUrl = required("HEDERA_MIRROR_NODE_URL");
const facilitatorUrl = required("X402_FACILITATOR_URL");
const signerPort = port("RESTRICTED_SIGNER_PORT");
const providerPort = port("RESOURCE_SERVER_PORT");
const orchestratorPort = port("ORCHESTRATOR_PORT");
const lenderPort = port("DIRECTORY_PORT");
if (new Set([signerPort, providerPort, orchestratorPort, lenderPort]).size !== 4) {
  throw new Error("Local service ports must be distinct");
}

const priceTinybar = BigInt(env.PROVIDER_A_PRICE_TINYBAR || "1000000");
const spendingCapTinybar = BigInt(env.DEFAULT_MISSION_SPENDING_CAP || priceTinybar.toString(10));
if (priceTinybar <= 0n) throw new Error("Provider price must be positive");
if (spendingCapTinybar < priceTinybar) throw new Error("Mission spending cap must cover the provider price");

const runId = `${new Date().toISOString().replaceAll(":", "-")}-${randomBytes(4).toString("hex")}`;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
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
  id: "provider-a",
  accountId: providerAccountId,
  endpoint: providerUrl,
  capability: "solidity-scan",
  priceTinybar,
  reputationScore: 0.9,
  expectedLatencyMs: 500,
};

let signerRuntime: SignerRuntime | undefined;
let paidScan: PaidScanServer | undefined;
let signerServer: Server | undefined;
let lenderServer: Server | undefined;
let providerServer: Server | undefined;
let orchestratorServer: Server | undefined;
let lenderDatabase: KovenDatabase | undefined;
let orchestratorDatabase: KovenDatabase | undefined;
let providerStore: ProviderStore | undefined;
let lenderClient: ReturnType<typeof createClient> | undefined;

try {
  if (resumeDirectory) {
    await Promise.all(["signer.db", "orchestrator.db", "provider.db"].map(file => access(resolve(runDirectory, file))));
  } else {
    await mkdir(runDirectory, { recursive: true });
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
    APPROVED_RECIPIENTS_ROOT: env.APPROVED_RECIPIENTS_ROOT || "1",
    SIGNER_PROOF_MODE: "deterministic",
    SIGNER_CONSUMER_CREDENTIAL: consumerCredential,
    SIGNER_ORCHESTRATOR_CREDENTIAL: orchestratorCredential,
    SIGNER_REGISTRAR_CREDENTIAL: registrarCredential,
    SIGNER_LENDER_CREDENTIALS: `${lenderAccountId}:${lenderCredential}`,
    SIGNER_LENDER_PUBLIC_KEYS: `${lenderAccountId}:${lenderKey.publicKey.toStringRaw()}`,
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
      ),
      registrationClient: new HttpLoanRegistrationClient(signerUrl, lenderCredential),
      lenderAccountId,
    });
    lenderServer = createLenderApp({
      store: lenderStore,
      policy: new ConservativeLenderPolicy({
        maxPrincipalTinybar: spendingCapTinybar,
        maxTermSeconds: 3_600,
        minimumReputation: 0,
        feeBasisPoints: 100,
      }),
      fundingService,
      lenderAccountId,
      lenderPrivateKey: lenderKey,
      operatorCredential: lenderOperatorCredential,
      borrowerPublicKey: accountId => accountId === consumerAccountId ? consumerKey.publicKey : undefined,
      borrowerReputation: () => 1,
    }).listen(lenderPort, "127.0.0.1");
    await listen(lenderServer);
  }

  const repaymentClient = new HttpRepaymentClient({
    baseUrl: signerUrl,
    credential: orchestratorCredential,
  });
  const createOrchestrator = (database: KovenDatabase) => {
    const stateMachine = new MissionStateMachine(database, { write: async () => undefined });
    const consumer = new ConsumerMissionExecutor({
      borrowerAccountId: consumerAccountId,
      // Exercise credit deliberately; the balance preflight above reserves repayment funds.
      balance: { getBalanceTinybar: async () => 0n },
      signer: new HttpCreditSigner({ baseUrl: signerUrl, credential: consumerCredential }),
      lender: new HttpLender({ baseUrl: lenderUrl, publicKey: lenderKey.publicKey }),
      payment: new ConsumerPaymentService({
        borrowerAccountId: consumerAccountId,
        authorizer: createHttpPaymentAuthorizer({ baseUrl: signerUrl, credential: consumerCredential }),
      }),
    });
    const workflow = new MissionWorkflow({
      database,
      stateMachine,
      consumer,
      policyRegistrars: [
        new HttpMissionPolicyRegistrar({ baseUrl: signerUrl, credential: registrarCredential }),
        new HttpMissionPolicyRegistrar({ baseUrl: lenderUrl, credential: lenderOperatorCredential }),
      ],
      providers: [provider],
      borrowerAccountId: consumerAccountId,
      approvedRecipientsRoot: env.APPROVED_RECIPIENTS_ROOT || "1",
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
  }

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
  if (!listMissionEvents(orchestratorDatabase, missionId).some(event => event.type === "callback-duplicate")) {
    throw new Error("Duplicate callback audit evidence is missing");
  }

  process.stdout.write(`${JSON.stringify({
    missionId,
    state: mission.state,
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
  paidScan?.callbacks.stop();
  paidScan?.settlements.stop();
  await Promise.all([
    closeServer(providerServer),
    closeServer(orchestratorServer),
    closeServer(lenderServer),
    closeServer(signerServer),
  ]);
  if (providerStore?.database.open) providerStore.close();
  if (orchestratorDatabase?.open) orchestratorDatabase.close();
  if (lenderDatabase?.open) lenderDatabase.close();
  lenderClient?.close();
  signerRuntime?.close();
}
