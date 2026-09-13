import { createHash } from "node:crypto";

import type { PaymentPayload } from "@x402/core/types";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { inspectHederaTransaction, Transaction, TransferTransaction } from "@x402/hedera";
import { validatePaidPaymentAttempt } from "@koven/resource-server";
import { getSpendingReservation, getSpendingSession } from "@koven/persistence";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import { normalizeChallenge } from "@koven/x402";

import { SCAN_AUTHORIZATION_DOMAIN, verifyDomain, withoutSignature } from "../src/canonical.js";
import { PaymentGate } from "../src/gate.js";
import { ProofPolicy } from "../src/proof.js";
import type { SignerStore } from "../src/store.js";
import {
  consumerAccountId,
  consumerKey,
  feePayerAccountId,
  memoryStore,
  poseidonHasher,
  policy,
  providerAccountId,
  requirements,
  scanUrl,
  targetSha256,
} from "./helpers.js";

const now = new Date("2026-09-12T12:00:00.000Z");
const stores: SignerStore[] = [];
afterEach(() => stores.splice(0).forEach(store => store.close()));

let gateFor: (store: SignerStore, overrides?: Partial<ConstructorParameters<typeof PaymentGate>[0]>) => PaymentGate;
beforeAll(async () => {
  const poseidon = await poseidonHasher();
  gateFor = (store, overrides = {}) => new PaymentGate({
    store,
    accountId: consumerAccountId,
    privateKey: consumerKey,
    network: "hedera:testnet",
    poseidon,
    ...overrides,
  });
});

const registered = (): SignerStore => {
  const store = memoryStore();
  stores.push(store);
  store.registerMissionPolicy(policy(), now.toISOString());
  return store;
};

const failure = async (run: Promise<unknown>, code: string, status: number) => {
  await expect(run).rejects.toMatchObject({ code, status });
};

describe("PaymentGate /authorize", () => {
  it("returns a fee-payer transfer with an authorization bound to those exact bytes", async () => {
    const store = registered();
    const response = await gateFor(store).authorize({ missionId: "mission-1", requirements: requirements(), nonce: "1" });

    const bytes = Buffer.from(response.transaction, "base64");
    const transaction = Transaction.fromBytes(bytes);
    expect(transaction).toBeInstanceOf(TransferTransaction);
    expect(transaction.transactionId?.accountId?.toString()).toBe(feePayerAccountId);
    const inspected = inspectHederaTransaction(response.transaction);
    expect(inspected.hbarTransfers).toHaveLength(2);

    const authorization = response.paymentAuthorization;
    expect(authorization).toMatchObject({
      missionId: "mission-1",
      targetSha256,
      transactionSha256: createHash("sha256").update(bytes).digest("hex"),
      transactionId: inspected.transactionId,
      borrowerAccountId: consumerAccountId,
      providerAccountId,
      scanUrl,
      amountTinybar: "1000000",
      network: "hedera:testnet",
      asset: "0.0.0",
      nonce: "1",
    });
    expect(Date.parse(authorization.expiresAt)).toBeGreaterThan(now.getTime());
    expect(verifyDomain(consumerKey.publicKey, SCAN_AUTHORIZATION_DOMAIN, withoutSignature(authorization), authorization.signature)).toBe(true);

    // The signer reserved the nonce, commitment and budget before returning bytes.
    expect(getSpendingReservation(store.database, "mission-1", "1")?.amountTinybar).toBe(1_000_000n);
    expect(getSpendingSession(store.database, "session-1")?.spentTinybar).toBe(1_000_000n);
    expect(store.getAuthorizationByTransactionId(inspected.transactionId)?.transactionBase64).toBe(response.transaction);
  });

  it("produces an authorization the resource server accepts before settlement", async () => {
    const source = "pragma solidity ^0.8.24; contract Paid {}";
    const sourceSha256 = createHash("sha256").update(source, "utf8").digest("hex");
    const store = memoryStore();
    stores.push(store);
    store.registerMissionPolicy(policy("mission-1", { targetSha256: sourceSha256 }), now.toISOString());
    const response = await gateFor(store).authorize({ missionId: "mission-1", requirements: requirements(), nonce: "9" });
    const payload: PaymentPayload = {
      x402Version: 2,
      accepted: requirements(),
      payload: { transaction: response.transaction },
    };

    const attempt = validatePaidPaymentAttempt(
      { missionId: "mission-1", targetRef: "Paid.sol", source, targetSha256: sourceSha256, paymentAuthorization: response.paymentAuthorization },
      encodePaymentSignatureHeader(payload),
      {
        providerAccountId,
        scanUrl,
        amountTinybar: "1000000",
        network: "hedera:testnet",
        asset: "0.0.0",
        feePayerAccountId,
        signerPublicKeys: { [consumerAccountId]: consumerKey.publicKey.toStringRaw() },
      },
      now,
    );
    expect(attempt.authorization).toEqual(response.paymentAuthorization);
    expect(attempt.authorizationExpired).toBe(false);
    expect(attempt.transactionValidUntil).toBe(Date.parse(response.paymentAuthorization.expiresAt));
  });

  it("rejects over-cap, wrong recipient, unprovisioned missions and unacceptable challenges", async () => {
    const store = registered();
    const gate = gateFor(store);
    await failure(gate.authorize({ missionId: "mission-1", requirements: requirements({ amount: "5000001" }), nonce: "1" }), "cap_exceeded", 403);
    await failure(gate.authorize({ missionId: "mission-1", requirements: requirements({ payTo: "0.0.2002" }), nonce: "1" }), "recipient_not_approved", 403);
    await failure(gate.authorize({ missionId: "mission-2", requirements: requirements(), nonce: "1" }), "mission_policy_missing", 403);
    await expect(gate.authorize({ missionId: "mission-1", requirements: { ...requirements(), scheme: "upto" } as never, nonce: "1" }))
      .rejects.toBeInstanceOf(ZodError);
    await failure(gate.authorize({ missionId: "mission-1", requirements: requirements({ amount: "0" }), nonce: "1" }), "challenge_binding_mismatch", 400);
    expect(getSpendingReservation(store.database, "mission-1", "1")).toBeUndefined();
  });

  it("consumes a nonce once, even with another challenge, and enforces the session budget", async () => {
    const store = registered();
    const gate = gateFor(store);
    await gate.authorize({ missionId: "mission-1", requirements: requirements(), nonce: "1" });
    await failure(gate.authorize({ missionId: "mission-1", requirements: requirements(), nonce: "1" }), "nonce_already_used", 409);
    await failure(gate.authorize({ missionId: "mission-1", requirements: requirements({ amount: "2000000" }), nonce: "1" }), "nonce_already_used", 409);

    // mission cap 5,000,000: 1,000,000 spent, 4,000,000 more fits, then nothing.
    await gate.authorize({ missionId: "mission-1", requirements: requirements({ amount: "4000000" }), nonce: "2" });
    await failure(gate.authorize({ missionId: "mission-1", requirements: requirements(), nonce: "3" }), "cumulative_budget_exceeded", 403);

    // session cap 8,000,000 across missions: a second mission can spend 3,000,000, not 4,000,000.
    store.registerMissionPolicy(policy("mission-2"), now.toISOString());
    await failure(gate.authorize({ missionId: "mission-2", requirements: requirements({ amount: "4000000" }), nonce: "1" }), "cumulative_budget_exceeded", 403);
    await gate.authorize({ missionId: "mission-2", requirements: requirements({ amount: "3000000" }), nonce: "1" });
    expect(getSpendingSession(store.database, "session-1")?.spentTinybar).toBe(8_000_000n);
  });

  it("consumes nothing when transaction construction fails", async () => {
    const store = registered();
    const gate = gateFor(store, {
      clientSigner: {
        accountId: consumerAccountId,
        createPartiallySignedTransferTransaction: vi.fn(async () => { throw new Error("signer unavailable"); }),
      },
    });
    await expect(gate.authorize({ missionId: "mission-1", requirements: requirements(), nonce: "1" })).rejects.toThrowError("signer unavailable");
    expect(getSpendingReservation(store.database, "mission-1", "1")).toBeUndefined();
    expect(getSpendingSession(store.database, "session-1")?.spentTinybar).toBe(0n);

    // The nonce is still available afterwards.
    await gateFor(store).authorize({ missionId: "mission-1", requirements: requirements(), nonce: "1" });
  });

  it("serialises concurrent authorizations of one mission and never double-reserves", async () => {
    const store = registered();
    const gate = gateFor(store);
    const results = await Promise.allSettled([
      gate.authorize({ missionId: "mission-1", requirements: requirements({ amount: "3000000" }), nonce: "1" }),
      gate.authorize({ missionId: "mission-1", requirements: requirements({ amount: "3000000" }), nonce: "2" }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(getSpendingSession(store.database, "session-1")?.spentTinybar).toBe(3_000_000n);
  });
});

describe("PaymentGate /authorize in zk mode", () => {
  const vkeyHash = "2d23ff5d6058a4de330abee1fdc1b68905da223f9ad8bdb681d598e38b6a257d";
  /** Test-only Groth16 stand-in, named explicitly; production wires snarkjs. */
  const fakeGroth16Verifier = (accept: boolean) => ({ verify: vi.fn(async () => accept) });
  const fakeBundle = (publicSignals: [string, string, string], overrides: Record<string, unknown> = {}) => ({
    proof: { protocol: "groth16", curve: "bn128", pi_a: ["1", "2", "1"], pi_b: [["1", "2"], ["3", "4"], ["1", "0"]], pi_c: ["5", "6", "1"] },
    publicSignals,
    vkeyHash,
    circuitId: "koven-policy-v1",
    ...overrides,
  }) as never;

  const zkGate = async (store: SignerStore, accept = true) => {
    const poseidon = await poseidonHasher();
    const proofPolicy = new ProofPolicy({ poseidon, trusted: { verificationKey: { protocol: "groth16" }, vkeyHash }, verifier: fakeGroth16Verifier(accept) });
    const gate = gateFor(store, { proofMode: "zk", proofPolicy });
    const root = proofPolicy.rootFor(providerAccountId);
    return { gate, proofPolicy, root };
  };
  const zkPolicy = (root: string, missionId = "mission-1") => policy(missionId, { approvedRecipientsRoot: root });
  const challengeFor = (missionId: string, nonce: string, amount = "1000000") => normalizeChallenge(
    requirements({ amount }), missionId, targetSha256, nonce, { scanUrl },
  );

  it("requires a bundle bound to the recomputed commitment, the stored root and the cap", async () => {
    const store = memoryStore();
    stores.push(store);
    const { gate, proofPolicy, root } = await zkGate(store);
    store.registerMissionPolicy(zkPolicy(root), now.toISOString(), account => proofPolicy.rootFor(account));

    await expect(gate.authorize({ missionId: "mission-1", requirements: requirements(), nonce: "1" })).rejects.toBeInstanceOf(ZodError);

    const commitment = proofPolicy.commitmentFor(challengeFor("mission-1", "1"));
    const response = await gate.authorize({
      missionId: "mission-1", requirements: requirements(), nonce: "1", bundle: fakeBundle([commitment, root, "5000000"]),
    });
    expect(response.paymentAuthorization.nonce).toBe("1");
    expect(getSpendingReservation(store.database, "mission-1", "1")?.paymentCommitment).toBe(commitment);
  });

  it("rejects proofs for another mission, another key, another root, a larger cap or that do not verify", async () => {
    const store = memoryStore();
    stores.push(store);
    const { gate, proofPolicy, root } = await zkGate(store);
    store.registerMissionPolicy(zkPolicy(root), now.toISOString());
    const commitment = proofPolicy.commitmentFor(challengeFor("mission-1", "2"));
    const foreign = proofPolicy.commitmentFor(challengeFor("mission-other", "2"));
    const attempt = (bundle: unknown) => gate.authorize({ missionId: "mission-1", requirements: requirements(), nonce: "2", bundle } as never);

    await failure(attempt(fakeBundle([foreign, root, "5000000"])), "challenge_binding_mismatch", 400);
    await failure(attempt(fakeBundle([commitment, root, "5000000"], { vkeyHash: "a".repeat(64) })), "proof_vkey_mismatch", 403);
    await failure(attempt(fakeBundle([commitment, root, "5000000"], { circuitId: "koven-policy-v2" })), "circuit_id_mismatch", 403);
    await failure(attempt(fakeBundle([commitment, "1", "5000000"])), "recipient_not_approved", 403);
    await failure(attempt(fakeBundle([commitment, root, "5000001"])), "cap_exceeded", 403);
    expect(getSpendingReservation(store.database, "mission-1", "2")).toBeUndefined();

    const rejecting = await zkGate(store, false);
    await failure(rejecting.gate.authorize({ missionId: "mission-1", requirements: requirements(), nonce: "2", bundle: fakeBundle([commitment, root, "5000000"]) }), "proof_invalid", 403);
  });

  it("only registers policies carrying the selected provider's singleton root", async () => {
    const store = memoryStore();
    stores.push(store);
    const { proofPolicy, root } = await zkGate(store);
    expect(() => store.registerMissionPolicy(zkPolicy("1"), now.toISOString(), account => proofPolicy.rootFor(account)))
      .toThrowError(expect.objectContaining({ code: "mission_policy_mismatch" }));
    expect(store.registerMissionPolicy(zkPolicy(root), now.toISOString(), account => proofPolicy.rootFor(account))).toBe("registered");
  });
});
