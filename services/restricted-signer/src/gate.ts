import { type ClientHederaSigner, createClientHederaSigner, inspectHederaTransaction, Transaction } from "@x402/hedera";
import { ErrorCode } from "@koven/domain";
import type { PrivateKey } from "@koven/hedera";
import { AuthorizeRequestSchema, AuthorizeResponseSchema, type HttpRequest, type HttpResponse } from "@koven/schemas";
import {
  challengeToFieldInputs,
  ChallengeRejectedError,
  type FieldHasher,
  normalizeChallenge,
  paymentCommitment,
} from "@koven/x402";

import { SCAN_AUTHORIZATION_DOMAIN, sha256Hex, signDomain } from "./canonical.js";
import { fail } from "./errors.js";
import type { SignerStore, WireAuthorization } from "./store.js";

export const CIRCUIT_ID = "koven-policy-v1";

/**
 * Serialises work per key so two authorizations for one mission never
 * interleave. The MVP runs a single signer instance; a multi-instance
 * deployment would need a database-backed lease instead of this local lock.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  /** Keys currently holding or waiting for the lock; zero once every task settled. */
  get size(): number {
    return this.tails.size;
  }

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export interface PaymentGateOptions {
  readonly store: SignerStore;
  readonly accountId: string;
  readonly privateKey: PrivateKey;
  readonly network: "hedera:testnet";
  /** Deployment milestone configuration; M2 only knows the deterministic gate. */
  readonly proofMode?: "deterministic";
  readonly poseidon: FieldHasher;
  readonly now?: () => Date;
  /** Test seam only; production always builds with the consumer key held here. */
  readonly clientSigner?: ClientHederaSigner;
}

/** Valid-start plus valid-duration of the signed transaction, in Unix milliseconds. */
export function transactionValidUntil(transactionBase64: string, transactionId: string): number {
  const validStart = /@(\d+)\.(\d{9})$/.exec(transactionId);
  const durationSeconds = Transaction.fromBytes(Buffer.from(transactionBase64, "base64")).transactionValidDuration;
  if (!validStart || !Number.isSafeInteger(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Transaction validity window is unavailable");
  }
  const startMs = (BigInt(validStart[1]!) * 1000n) + (BigInt(validStart[2]!) / 1_000_000n);
  return Number(startMs + (BigInt(durationSeconds) * 1000n));
}

/**
 * The deterministic M2 payment gate. Order is fixed by the roadmap (A2.4):
 * re-normalise the challenge server-side from trusted policy, check cap and
 * approved recipient against the signer's own policy store, then under a
 * per-mission lock build the signed transfer and atomically consume the nonce
 * and commitment and reserve budget before any bytes leave the process. The
 * ZK check of M3 slots in after normalization without changing this sequence.
 */
export class PaymentGate {
  private readonly mutex = new KeyedMutex();
  private readonly now: () => Date;
  private readonly clientSigner: ClientHederaSigner;

  constructor(private readonly options: PaymentGateOptions) {
    if ((options.proofMode ?? "deterministic") !== "deterministic") throw new Error("Unsupported payment gate mode");
    this.now = options.now ?? (() => new Date());
    this.clientSigner = options.clientSigner
      ?? createClientHederaSigner(options.accountId, options.privateKey, { network: options.network });
  }

  async authorize(input: HttpRequest<"authorize">): Promise<HttpResponse<"authorize">> {
    const request = AuthorizeRequestSchema.parse(input);
    const policy = this.options.store.getMissionPolicy(request.missionId);
    if (policy === undefined) fail(ErrorCode.MISSION_POLICY_MISSING, "Mission policy is not provisioned");

    const scanUrl = `${policy.provider.endpoint}/scan`;
    let challenge;
    try {
      challenge = normalizeChallenge(request.requirements, policy.missionId, policy.targetSha256, request.nonce, {
        scanUrl,
        policy: { network: this.options.network, asset: "0.0.0" },
      });
    } catch (error) {
      if (error instanceof ChallengeRejectedError) fail(ErrorCode.CHALLENGE_BINDING_MISMATCH, error.message);
      throw error;
    }
    if (challenge.recipientAccountId !== policy.provider.accountId) {
      fail(ErrorCode.RECIPIENT_NOT_APPROVED, "Challenge recipient is not the mission's selected provider");
    }
    if (challenge.amountTinybar > BigInt(policy.spendingCapTinybar)) {
      fail(ErrorCode.CAP_EXCEEDED, "Challenge amount exceeds the mission spending cap");
    }
    const commitment = paymentCommitment(challengeToFieldInputs(challenge, this.options.poseidon), this.options.poseidon).toString(10);

    return this.mutex.run(policy.missionId, async () => {
      const transaction = await this.clientSigner.createPartiallySignedTransferTransaction(request.requirements);
      const bytes = Buffer.from(transaction, "base64");
      const inspected = inspectHederaTransaction(transaction);
      if (inspected.transactionIdAccountId !== request.requirements.extra.feePayer) {
        fail(ErrorCode.INTERNAL_ERROR, "Built transaction is not paid by the advertised fee payer");
      }
      const validUntil = transactionValidUntil(transaction, inspected.transactionId);
      const now = this.now();
      if (validUntil <= now.getTime()) fail(ErrorCode.INTERNAL_ERROR, "Built transaction is already expired");

      const unsigned = {
        missionId: policy.missionId,
        targetSha256: policy.targetSha256,
        transactionSha256: sha256Hex(bytes),
        transactionId: inspected.transactionId,
        borrowerAccountId: this.options.accountId,
        providerAccountId: policy.provider.accountId,
        scanUrl,
        amountTinybar: request.requirements.amount,
        network: this.options.network,
        asset: "0.0.0" as const,
        nonce: request.nonce,
        expiresAt: new Date(validUntil).toISOString(),
      };
      const authorization: WireAuthorization = {
        ...unsigned,
        signature: signDomain(this.options.privateKey, SCAN_AUTHORIZATION_DOMAIN, unsigned),
      };

      // Nonce, commitment and budget are consumed in one transaction; on any
      // failure the built bytes are discarded and nothing was reserved.
      this.options.store.reserveAuthorization({
        missionId: policy.missionId,
        nonce: request.nonce,
        commitment,
        transactionBase64: transaction,
        authorization,
        validUntil,
      }, now.toISOString());

      return AuthorizeResponseSchema.parse({ transaction, paymentAuthorization: authorization });
    });
  }
}
