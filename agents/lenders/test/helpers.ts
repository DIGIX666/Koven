import type { Server } from "node:http";

import type { Application } from "express";
import { canonicalHash, signCreditAcceptance, signCreditRequest } from "@koven/credit-protocol";
import type { CreditAcceptance, CreditOffer, CreditRequest } from "@koven/domain";
import { PrivateKey } from "@koven/hedera";
import { openDatabase, type KovenDatabase } from "@koven/persistence";
import { CreditOfferSchema, LoanRegistrationRequestSchema, type HttpRequest } from "@koven/schemas";

import {
  ConservativeLenderPolicy,
  createLenderApp,
  FundingService,
  LenderStore,
  type FundingGateway,
  type FundingTransfer,
  type LenderPolicy,
  type LenderProofMode,
  type LenderProofVerifier,
  type LoanRegistrationClient,
} from "../src/index.js";

export const now = "2026-09-11T12:00:00.000Z";
export const lenderKey = PrivateKey.generateECDSA();
export const borrowerKey = PrivateKey.generateECDSA();
export const operatorCredential = "operator-credential-abcdefghijklmnopqrstuvwxyz";
export const transactionId = "0.0.20@1789128000.000000001";
export const databases: KovenDatabase[] = [];
export const servers: Server[] = [];

export class FakeFundingGateway implements FundingGateway {
  readonly transfers: Omit<FundingTransfer, "onPrepared">[] = [];
  reconciliations = 0;
  failBeforePrepare = false;
  failAfterPrepare = false;
  preparedTransactionId = transactionId;
  returnedTransactionId = transactionId;
  reconciliation: "confirmed" | "pending" | "failed" = "confirmed";

  async transfer(input: FundingTransfer): Promise<{ transactionId: string }> {
    this.transfers.push({
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      amountTinybar: input.amountTinybar,
      memo: input.memo,
    });
    if (this.failBeforePrepare) throw new Error("funding unavailable");
    input.onPrepared(this.preparedTransactionId);
    if (this.failAfterPrepare) throw new Error("submission timed out");
    return { transactionId: this.returnedTransactionId };
  }

  async reconcile(): Promise<"confirmed" | "pending" | "failed"> {
    this.reconciliations += 1;
    return this.reconciliation;
  }
}

export class FakeRegistrationClient implements LoanRegistrationClient {
  readonly requests: HttpRequest<"registerLoan">[] = [];
  failures = 0;

  async register(request: HttpRequest<"registerLoan">): Promise<void> {
    this.requests.push(LoanRegistrationRequestSchema.parse(request));
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("signer unavailable");
    }
  }
}

export interface RuntimeOptions {
  database?: KovenDatabase;
  gateway?: FakeFundingGateway;
  registration?: FakeRegistrationClient;
  reputation?: number;
  maxPrincipalTinybar?: bigint;
  clock?: () => string;
  proofMode?: LenderProofMode;
  proofVerifier?: LenderProofVerifier;
  lenderAccountId?: string;
  lenderPrivateKey?: PrivateKey;
  lenderPolicy?: LenderPolicy;
}

export interface LenderRuntime {
  app: Application;
  database: KovenDatabase;
  store: LenderStore;
  gateway: FakeFundingGateway;
  registration: FakeRegistrationClient;
}

export const runtime = (options: RuntimeOptions = {}): LenderRuntime => {
  const database = options.database ?? openDatabase(":memory:");
  if (options.database === undefined) databases.push(database);
  const store = new LenderStore(database);
  const gateway = options.gateway ?? new FakeFundingGateway();
  const registration = options.registration ?? new FakeRegistrationClient();
  const clock = options.clock ?? (() => now);
  const lenderAccountId = options.lenderAccountId ?? "0.0.20";
  const lenderPrivateKey = options.lenderPrivateKey ?? lenderKey;
  const fundingService = new FundingService({
    store,
    gateway,
    registrationClient: registration,
    lenderAccountId,
    now: clock,
  });
  const app = createLenderApp({
    store,
    policy: options.lenderPolicy ?? new ConservativeLenderPolicy({
      maxPrincipalTinybar: options.maxPrincipalTinybar ?? 1_000n,
      maxTermSeconds: 7_200,
      minReputationScore: 0.8,
      feeBps: 500,
    }),
    fundingService,
    lenderAccountId,
    lenderPrivateKey,
    operatorCredential,
    borrowerPublicKey: accountId => accountId === "0.0.10" ? borrowerKey.publicKey : undefined,
    borrowerReputation: () => options.reputation ?? 0.9,
    now: clock,
    offerValiditySeconds: 300,
    ...(options.proofMode === undefined ? {} : { proofMode: options.proofMode }),
    ...(options.proofVerifier === undefined ? {} : { proofVerifier: options.proofVerifier }),
  });
  return { app, database, store, gateway, registration };
};

export const listen = async (app: Application): Promise<string> => {
  const server = await new Promise<Server>((resolve, reject) => {
    const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
    candidate.once("error", reject);
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test address");
  return `http://127.0.0.1:${address.port}`;
};

export const policy = (overrides: Partial<HttpRequest<"registerMissionPolicy">> = {}) => ({
  missionId: "mission-1",
  borrowerAccountId: "0.0.10",
  spendingCapTinybar: "1000",
  sessionId: "session-1",
  sessionCapTinybar: "2000",
  targetSha256: "a".repeat(64),
  provider: {
    id: "provider-1",
    accountId: "0.0.30",
    endpoint: "https://provider.example",
    capability: "solidity-scan",
    priceTinybar: "100",
    reputationScore: 0.9,
    expectedLatencyMs: 50,
  },
  approvedRecipientsRoot: "1",
  ...overrides,
});

export const signedRequest = (overrides: Partial<CreditRequest> = {}) => signCreditRequest({
  id: "request-1",
  missionId: "mission-1",
  borrowerAccountId: "0.0.10",
  principalTinybar: 100n,
  requestedTermSeconds: 3_600,
  purposeHash: canonicalHash({ missionId: "mission-1", targetSha256: "a".repeat(64) }),
  createdAt: now,
  ...overrides,
}, borrowerKey);

export const requestWire = (request: CreditRequest) => ({
  ...request,
  principalTinybar: request.principalTinybar.toString(10),
});

export const offerDomain = (wire: ReturnType<typeof CreditOfferSchema.parse>): CreditOffer => ({
  ...wire,
  principalTinybar: BigInt(wire.principalTinybar),
  feeTinybar: BigInt(wire.feeTinybar),
});

export const registerPolicy = async (baseUrl: string, body = policy()) => fetch(
  `${baseUrl}/internal/missions/register`,
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${operatorCredential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  },
);

export const quote = async (baseUrl: string, request = signedRequest()) => {
  const response = await fetch(`${baseUrl}/credit/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestWire(request)),
  });
  return { response, request };
};

export const acceptanceWire = (
  request: CreditRequest,
  offer: CreditOffer,
  evidence: Pick<CreditAcceptance, "paymentIntentHash" | "paymentProofBundleHash"> = {},
) => signCreditAcceptance({
  requestId: request.id,
  missionId: request.missionId,
  borrowerAccountId: request.borrowerAccountId,
  lenderAccountId: offer.lenderAccountId,
  offerId: offer.id,
  termsHash: offer.termsHash,
  expiresAt: offer.expiresAt,
  ...evidence,
}, borrowerKey);

export const postAcceptance = async (baseUrl: string, body: object) => fetch(
  `${baseUrl}/credit/accept`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  },
);

/** Registers the mission policy, quotes and returns the domain offer with its signed request. */
export const quotedOffer = async (baseUrl: string, body = policy()) => {
  await registerPolicy(baseUrl, body);
  const quoted = await quote(baseUrl);
  const offer = offerDomain(CreditOfferSchema.parse(await quoted.response.json()));
  return { request: quoted.request, offer };
};

export const closeRuntimes = async (): Promise<void> => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error));
  })));
  for (const database of databases.splice(0)) database.close();
};
