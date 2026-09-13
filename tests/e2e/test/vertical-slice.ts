import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { inspectHederaTransaction } from "@x402/hedera";
import {
  ConsumerMissionExecutor,
  ConsumerPaymentService,
  HttpCreditSigner,
  HttpLender,
  ZkPolicyProver,
} from "@koven/consumer-agent";
import { ErrorCode, type Provider } from "@koven/domain";
import { explorerUrl, PrivateKey } from "@koven/hedera";
import {
  ConservativeLenderPolicy,
  createLenderApp,
  FundingService,
  HttpLoanRegistrationClient,
  LenderProofVerifier,
  LenderStore,
  type FundingTransfer,
} from "@koven/lender-agents";
import {
  CompletionHandler,
  createOrchestratorApp,
  HttpMissionPolicyRegistrar,
  HttpRepaymentClient,
  HttpSignerCompletionClient,
  MissionStateMachine,
  MissionWorkflow,
  RepaymentRequestError,
  RepaymentWorkflow,
} from "@koven/orchestrator";
import {
  getLoanByMission,
  getMission,
  listMissionEvents,
  openDatabase,
  type KovenDatabase,
} from "@koven/persistence";
import {
  CallbackDispatcher,
  createPaidScanServer,
  ProviderStore,
} from "@koven/resource-server";
import {
  CompletionService,
  CreditService,
  PaymentGate,
  ProofPolicy,
  RepaymentService,
  createSignerApp,
  SignerStore,
  type RepaymentTransfer,
} from "@koven/restricted-signer";
import { HealthResponseSchema, MissionDetailResponseSchema, MissionSchema } from "@koven/schemas";
import { createHttpPaymentAuthorizer, loadPoseidon } from "@koven/x402";
import { buildMerkleTree, loadOfficialArtifacts } from "@koven/zk-policy";
import { expect, vi } from "vitest";

const consumerAccountId = "0.0.1001";
const lenderAccountId = "0.0.2001";
const providerAccountId = "0.0.3001";
const feePayerAccountId = "0.0.4001";
const priceTinybar = 1_000_000n;
const fundingTxId = "0.0.2001@1789293600.000000001";
const repaymentTxId = "0.0.1001@1789293600.000000002";
const missionId = "mission-vertical";
const credentials = {
  consumer: "c".repeat(43),
  orchestrator: "o".repeat(43),
  registrar: "r".repeat(43),
  lender: "l".repeat(43),
  lenderOperator: "p".repeat(43),
};
const callbackSecret = Buffer.alloc(32, 7);

interface TransferRecord {
  readonly payerAccountId: string;
  readonly recipientAccountId: string;
  readonly amountTinybar: bigint;
}

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close(() => address && typeof address !== "string"
      ? resolve(address.port)
      : reject(new Error("Could not reserve a loopback port")));
  });
});

const listen = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
};

const close = (server: Server | undefined): Promise<void> => new Promise((resolve, reject) => {
  if (server === undefined || !server.listening) {
    resolve();
    return;
  }
  server.close(error => error === undefined ? resolve() : reject(error));
});

const serverOrigin = (server: Server): string => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
};

class OfflineFacilitator implements FacilitatorClient {
  constructor(
    private readonly transfers: Map<string, TransferRecord>,
    private readonly onSettlement: (transactionId: string) => void,
  ) {}

  readonly verify = vi.fn(async (
    payload: PaymentPayload,
    _requirements: PaymentRequirements,
  ): Promise<VerifyResponse> => ({
    isValid: true,
    payer: consumerAccountId,
    extra: {
      transactionId: inspectHederaTransaction(String(payload.payload.transaction)).transactionId,
    },
  }));

  readonly settle = vi.fn(async (
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> => {
    const transactionId = inspectHederaTransaction(String(payload.payload.transaction)).transactionId;
    this.transfers.set(transactionId, {
      payerAccountId: consumerAccountId,
      recipientAccountId: requirements.payTo,
      amountTinybar: BigInt(requirements.amount),
    });
    this.onSettlement(transactionId);
    return {
      success: true,
      payer: consumerAccountId,
      transaction: transactionId,
      network: "hedera:testnet",
      amount: requirements.amount,
    };
  });

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [{
        x402Version: 2,
        scheme: "exact",
        network: "hedera:testnet",
        extra: { feePayer: feePayerAccountId },
      }],
      extensions: [],
      signers: {},
    };
  }
}

export interface VerticalSliceOptions {
  /** The signer's deployment setting; `zk` proves every payment with the official artifacts. */
  readonly proofMode: "deterministic" | "zk";
}

/**
 * Runs real HTTP services end to end: a keyless mission that borrows, pays a
 * provider, recovers a lost callback after an orchestrator restart and repays
 * exactly once. In zk mode the consumer proves the payment intent before credit
 * and the signer refuses anything that is not a verified, correctly bound proof.
 */
export async function runVerticalSlice({ proofMode }: VerticalSliceOptions): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "koven-vertical-"));
  const signerPath = join(directory, "signer.sqlite");
  const lenderPath = join(directory, "lender.sqlite");
  const providerPath = join(directory, "provider.sqlite");
  const orchestratorPath = join(directory, "orchestrator.sqlite");
  const consumerKey = PrivateKey.generateECDSA();
  const lenderKey = PrivateKey.generateECDSA();
  const poseidon = await loadPoseidon();
  const artifacts = proofMode === "zk" ? loadOfficialArtifacts() : undefined;
  const proofPolicy = artifacts === undefined
    ? undefined
    : new ProofPolicy({ poseidon, trusted: { verificationKey: artifacts.verificationKey, vkeyHash: artifacts.vkeyHash } });
  const zkOptions = proofPolicy === undefined ? {} : { proofMode: "zk" as const, proofPolicy };
  // The lender verifies with its own copy of the key, never through the signer's policy object.
  const lenderZkOptions = artifacts === undefined ? {} : {
    proofMode: "zk" as const,
    proofVerifier: new LenderProofVerifier({
      poseidon,
      trusted: { verificationKey: artifacts.verificationKey, vkeyHash: artifacts.vkeyHash },
    }),
  };
  const transfers = new Map<string, TransferRecord>();
  // A partial balance: the loan still covers the whole payment amount.
  const balances = new Map([[consumerAccountId, 1n]]);
  let clock = Date.now();
  const settledAt = new Date(clock).toISOString();
  let paymentTxId: string | undefined;
  let signerStore: SignerStore | undefined;
  let lenderDatabase: KovenDatabase | undefined;
  let providerStore: ProviderStore | undefined;
  let orchestratorDatabase: KovenDatabase | undefined;
  let signerServer: Server | undefined;
  let lenderServer: Server | undefined;
  let providerServer: Server | undefined;
  let orchestratorServer: Server | undefined;
  const signerPort = await freePort();
  const providerPort = await freePort();
  const orchestratorPort = await freePort();
  const signerUrl = `http://127.0.0.1:${signerPort}`;
  const providerUrl = `http://127.0.0.1:${providerPort}`;
  const orchestratorUrl = `http://127.0.0.1:${orchestratorPort}`;
  let lenderUrl = "";

  const confirmTransfer = vi.fn(async (expectation: {
    transactionId: string;
    payerAccountId: string;
    recipientAccountId: string;
    amountTinybar: bigint;
  }) => {
    expect(transfers.get(expectation.transactionId)).toEqual({
      payerAccountId: expectation.payerAccountId,
      recipientAccountId: expectation.recipientAccountId,
      amountTinybar: expectation.amountTinybar,
    });
    return { settledAt };
  });
  const repaymentLedger = {
    prepare: vi.fn(async (transfer: RepaymentTransfer) => {
      transfers.set(repaymentTxId, {
        payerAccountId: transfer.from,
        recipientAccountId: transfer.to,
        amountTinybar: transfer.amountTinybar,
      });
      return {
        transactionId: repaymentTxId,
        transactionBase64: Buffer.from("stable-repayment-transaction").toString("base64"),
        validUntil: clock + 180_000,
      };
    }),
    submit: vi.fn(async () => "success" as const),
  };

  const signerApplication = (store: SignerStore) => createSignerApp({
    store,
    gate: new PaymentGate({
      store,
      accountId: consumerAccountId,
      privateKey: consumerKey,
      network: "hedera:testnet",
      poseidon,
      now: () => new Date(clock),
      ...zkOptions,
    }),
    credit: new CreditService({
      store,
      accountId: consumerAccountId,
      privateKey: consumerKey,
      lenderPublicKeys: { [lenderAccountId]: lenderKey.publicKey.toStringRaw() },
      confirmer: { confirm: confirmTransfer },
      now: () => new Date(clock).toISOString(),
      ...zkOptions,
    }),
    completion: new CompletionService({
      store,
      accountId: consumerAccountId,
      providerCallbackSecrets: { "provider-a": callbackSecret },
      confirmer: { confirm: confirmTransfer },
      now: () => new Date(clock),
    }),
    repayment: new RepaymentService({
      store,
      accountId: consumerAccountId,
      ledger: repaymentLedger,
      confirmer: { confirm: confirmTransfer },
      now: () => new Date(clock),
    }),
    credentials: {
      consumer: credentials.consumer,
      orchestrator: credentials.orchestrator,
      registrar: credentials.registrar,
      lenders: { [credentials.lender]: lenderAccountId },
    },
    ...(proofPolicy === undefined ? {} : { proofPolicy }),
    now: () => new Date(clock),
  });

  const repaymentClient = new HttpRepaymentClient({
    baseUrl: signerUrl,
    credential: credentials.orchestrator,
  });
  const provider: Provider = {
    id: "provider-a",
    accountId: providerAccountId,
    endpoint: providerUrl,
    capability: "solidity-scan",
    priceTinybar,
    reputationScore: 0.9,
    expectedLatencyMs: 50,
  };

  const createOrchestrator = (database: KovenDatabase) => {
    let eventSequence = 0;
    const stateMachine = new MissionStateMachine(database, { write: async () => undefined }, {
      now: () => new Date(clock).toISOString(),
      eventId: () => `event-${clock}-${++eventSequence}`,
    });
    const consumer = new ConsumerMissionExecutor({
      borrowerAccountId: consumerAccountId,
      balance: {
        getBalanceTinybar: async accountId => balances.get(accountId) ?? 0n,
      },
      signer: new HttpCreditSigner({ baseUrl: signerUrl, credential: credentials.consumer }),
      lender: new HttpLender({
        baseUrl: lenderUrl,
        publicKey: lenderKey.publicKey,
        now: () => new Date(clock).toISOString(),
      }),
      payment: new ConsumerPaymentService({
        borrowerAccountId: consumerAccountId,
        authorizer: createHttpPaymentAuthorizer({
          baseUrl: signerUrl,
          credential: credentials.consumer,
        }),
        nonce: () => "1",
        now: () => new Date(clock).toISOString(),
        ...(artifacts === undefined ? {} : { prover: new ZkPolicyProver({ artifacts, poseidon }) }),
      }),
      now: () => new Date(clock).toISOString(),
      requestId: () => "credit-vertical",
      fundingRetryDelayMs: 1,
    });
    const workflow = new MissionWorkflow({
      database,
      stateMachine,
      consumer,
      policyRegistrars: [
        new HttpMissionPolicyRegistrar({ baseUrl: signerUrl, credential: credentials.registrar }),
        new HttpMissionPolicyRegistrar({
          baseUrl: lenderUrl,
          credential: credentials.lenderOperator,
        }),
      ],
      providers: [provider],
      borrowerAccountId: consumerAccountId,
      poseidon,
      now: () => new Date(clock).toISOString(),
      missionId: () => missionId,
    });
    const completionHandler = new CompletionHandler({
      database,
      stateMachine,
      providerCallbackSecrets: { [provider.id]: callbackSecret },
      settlementConfirmer: { confirm: confirmTransfer },
      signerCompletion: new HttpSignerCompletionClient({ baseUrl: signerUrl }),
      now: () => new Date(clock),
    });
    const repaymentWorkflow = new RepaymentWorkflow({
      database,
      stateMachine,
      client: repaymentClient,
    });
    return createOrchestratorApp({ database, workflow, completionHandler, repaymentWorkflow });
  };

  try {
    signerStore = new SignerStore(signerPath);
    signerServer = signerApplication(signerStore).listen(signerPort, "127.0.0.1");
    await listen(signerServer);
    const health = HealthResponseSchema.parse(await (await fetch(`${signerUrl}/health`)).json());
    expect(health.vkeyHash).toBe(artifacts?.vkeyHash ?? null);

    lenderDatabase = openDatabase(lenderPath);
    const lenderStore = new LenderStore(lenderDatabase);
    const fundingGateway = {
      transfer: vi.fn(async (input: FundingTransfer) => {
        input.onPrepared(fundingTxId);
        transfers.set(fundingTxId, {
          payerAccountId: input.fromAccountId,
          recipientAccountId: input.toAccountId,
          amountTinybar: input.amountTinybar,
        });
        balances.set(input.toAccountId, (balances.get(input.toAccountId) ?? 0n) + input.amountTinybar);
        return { transactionId: fundingTxId };
      }),
      reconcile: vi.fn(async () => "confirmed" as const),
    };
    const fundingService = new FundingService({
      store: lenderStore,
      gateway: fundingGateway,
      registrationClient: new HttpLoanRegistrationClient(signerUrl, credentials.lender),
      lenderAccountId,
      now: () => new Date(clock).toISOString(),
    });
    lenderServer = createLenderApp({
      store: lenderStore,
      policy: new ConservativeLenderPolicy({
        maxPrincipalTinybar: priceTinybar,
        maxTermSeconds: 3_600,
        minReputationScore: 0.8,
        feeBps: 500,
      }),
      fundingService,
      lenderAccountId,
      lenderPrivateKey: lenderKey,
      operatorCredential: credentials.lenderOperator,
      borrowerPublicKey: accountId => accountId === consumerAccountId ? consumerKey.publicKey : undefined,
      borrowerReputation: () => 0.9,
      now: () => new Date(clock).toISOString(),
      ...lenderZkOptions,
    }).listen(0, "127.0.0.1");
    await listen(lenderServer);
    lenderUrl = serverOrigin(lenderServer);

    let loseFirstCallbackResponse = true;
    const lossyCallbackFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (loseFirstCallbackResponse) {
        loseFirstCallbackResponse = false;
        throw new TypeError("Injected lost callback response");
      }
      return response;
    };
    providerStore = new ProviderStore(providerPath);
    const facilitator = new OfflineFacilitator(transfers, transactionId => { paymentTxId = transactionId; });
    const paidScan = await createPaidScanServer({
      providerId: provider.id,
      providerAccountId,
      scanUrl: `${providerUrl}/scan`,
      amountTinybar: priceTinybar.toString(10),
      network: "hedera:testnet",
      asset: "0.0.0",
      signerPublicKeys: { [consumerAccountId]: consumerKey.publicKey.toStringRaw() },
      facilitatorUrl: "https://facilitator.invalid",
      facilitatorClient: facilitator,
      store: providerStore,
      settlementConfirmer: {
        confirm: async expectation => confirmTransfer({
          transactionId: expectation.transactionId,
          payerAccountId: expectation.payerAccountId,
          recipientAccountId: expectation.providerAccountId,
          amountTinybar: BigInt(expectation.amountTinybar),
        }),
      },
      callbackUrl: `${orchestratorUrl}/callbacks/mission-complete`,
      callbackSecret,
      callbackFetch: lossyCallbackFetch,
      callbackRandom: () => 0,
      now: () => new Date(clock),
      dispatchCallbacks: false,
      reconcileSettlements: false,
    });
    providerServer = paidScan.app.listen(providerPort, "127.0.0.1");
    await listen(providerServer);

    orchestratorDatabase = openDatabase(orchestratorPath);
    const initialOrchestratorServer = createOrchestrator(orchestratorDatabase)
      .listen(orchestratorPort, "127.0.0.1");
    orchestratorServer = initialOrchestratorServer;
    await listen(initialOrchestratorServer);

    const createdResponse = await fetch(`${orchestratorUrl}/missions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "Audit the Solidity contract",
        maxBudgetTinybar: priceTinybar.toString(10),
        targetRef: "Vault.sol",
        source: "pragma solidity ^0.8.24; contract Vault { function value() external pure returns (uint256) { return 1; } }",
      }),
    });
    expect(createdResponse.status, await createdResponse.clone().text()).toBe(201);
    expect(MissionSchema.parse(await createdResponse.json()).state).toBe("running");
    expect(paymentTxId).toBeDefined();
    const loan = getLoanByMission(orchestratorDatabase, missionId);
    expect(loan?.state).toBe("funded");
    expect(signerStore.getLoan(loan!.id)?.state).toBe("funded");
    expect(lenderStore.getFundingByOffer(loan!.offerId)?.status).toBe("registered");
    expect(providerStore.getPayment(paymentTxId!)?.status).toBe("completed");
    const singletonRoot = buildMerkleTree([providerAccountId], poseidon).root;
    expect(getMission(orchestratorDatabase, missionId)?.approvedRecipientsRoot).toBe(singletonRoot);
    expect(signerStore.getMissionPolicy(missionId)?.approvedRecipientsRoot).toBe(singletonRoot);
    const eventTypes = listMissionEvents(orchestratorDatabase, missionId).map(event => event.type);
    expect(eventTypes.includes("proof-generated")).toBe(proofMode === "zk");
    if (proofMode === "zk") {
      // The proof precedes credit: the same bound intent is accepted, funded and then paid.
      expect(eventTypes.indexOf("proof-generated")).toBeLessThan(eventTypes.indexOf("credit-requested"));
      expect(signerStore.getAcceptance(missionId)?.acceptance.paymentIntentHash).toBeDefined();
    }

    expect(await paidScan.callbacks.dispatchDue()).toBe(1);
    expect(getMission(orchestratorDatabase, missionId)?.state).toBe("closed");
    expect(repaymentLedger.prepare).toHaveBeenCalledTimes(1);
    expect(repaymentLedger.prepare).toHaveBeenCalledWith({
      from: consumerAccountId,
      to: lenderAccountId,
      amountTinybar: loan!.principalTinybar + loan!.feeTinybar,
      memo: `repayment:${loan!.id}`,
    });
    expect(repaymentLedger.submit).toHaveBeenCalledTimes(1);

    await close(orchestratorServer);
    orchestratorServer = undefined;
    orchestratorDatabase.close();
    orchestratorDatabase = openDatabase(orchestratorPath);
    const restartedOrchestratorServer = createOrchestrator(orchestratorDatabase)
      .listen(orchestratorPort, "127.0.0.1");
    orchestratorServer = restartedOrchestratorServer;
    await listen(restartedOrchestratorServer);

    paidScan.callbacks.stop();
    paidScan.settlements.stop();
    providerStore.close();
    providerStore = new ProviderStore(providerPath);
    clock += 10;
    const replayResponses: { status: number; body: unknown }[] = [];
    const replayFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      replayResponses.push({
        status: response.status,
        body: await response.clone().json().catch(() => undefined),
      });
      return response;
    };
    const restartedDispatcher = new CallbackDispatcher({
      store: providerStore,
      callbackUrl: `${orchestratorUrl}/callbacks/mission-complete`,
      callbackSecret,
      fetch: replayFetch,
      now: () => clock,
      random: () => 0,
    });
    for (let attempt = 0; attempt < 3 && replayResponses.length === 0; attempt += 1) {
      expect(await restartedDispatcher.dispatchDue()).toBe(1);
      clock += 10;
    }
    expect(replayResponses).toEqual([{ status: 202, body: {
      status: "duplicate",
      code: "callback_duplicate",
    } }]);
    expect(getMission(orchestratorDatabase, missionId)?.state).toBe("closed");
    expect(listMissionEvents(orchestratorDatabase, missionId).map(event => event.type))
      .toContain("callback-duplicate");
    expect(repaymentLedger.prepare).toHaveBeenCalledTimes(1);
    expect(repaymentLedger.submit).toHaveBeenCalledTimes(1);

    await close(signerServer);
    signerServer = undefined;
    signerStore.close();
    signerStore = new SignerStore(signerPath);
    signerServer = signerApplication(signerStore).listen(signerPort, "127.0.0.1");
    await listen(signerServer);
    const repeatedRepayment = {
      missionId,
      loanId: loan!.id,
      idempotencyKey: `repayment:${loan!.id}`,
    };
    let repeatResult;
    try {
      repeatResult = await repaymentClient.repay(repeatedRepayment);
    } catch (error) {
      if (!(error instanceof RepaymentRequestError)
        || error.code !== ErrorCode.SETTLEMENT_UNCONFIRMED) throw error;
      repeatResult = await repaymentClient.repay(repeatedRepayment);
    }
    expect(repeatResult).toEqual({ transactionId: repaymentTxId });
    expect(repaymentLedger.prepare).toHaveBeenCalledTimes(1);
    expect(listMissionEvents(signerStore.database, missionId).map(event => event.type))
      .toContain("repayment-idempotency-hit");

    const detail = MissionDetailResponseSchema.parse(await (
      await fetch(`${orchestratorUrl}/missions/${missionId}`)
    ).json());
    expect(detail.state).toBe("closed");
    expect([
      explorerUrl(fundingTxId),
      explorerUrl(paymentTxId!),
      explorerUrl(repaymentTxId),
    ]).toEqual([
      `https://hashscan.io/testnet/transaction/${fundingTxId}`,
      `https://hashscan.io/testnet/transaction/${paymentTxId!}`,
      `https://hashscan.io/testnet/transaction/${repaymentTxId}`,
    ]);
  } finally {
    await Promise.all([
      close(orchestratorServer),
      close(providerServer),
      close(lenderServer),
      close(signerServer),
    ]);
    if (orchestratorDatabase?.open) orchestratorDatabase.close();
    if (lenderDatabase?.open) lenderDatabase.close();
    providerStore?.close();
    signerStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
