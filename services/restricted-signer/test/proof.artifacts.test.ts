import { createHash } from "node:crypto";
import type { Server } from "node:http";

import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { CREDIT_SIGNATURE_DOMAINS } from "@koven/domain";
import { validatePaidPaymentAttempt } from "@koven/resource-server";
import { loadPoseidon, normalizeChallenge } from "@koven/x402";
import { buildWitness, loadOfficialArtifacts, prove } from "@koven/zk-policy";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { signDomain } from "../src/canonical.js";
import { CompletionService } from "../src/completion.js";
import { CreditService, purposeHashFor, termsHashFor } from "../src/credit.js";
import { PaymentGate } from "../src/gate.js";
import { ProofPolicy } from "../src/proof.js";
import { RepaymentService } from "../src/repay.js";
import { createSignerApp } from "../src/server.js";
import type { SignerStore } from "../src/store.js";
import {
  consumerAccountId,
  consumerKey,
  credentials,
  feePayerAccountId,
  lenderAccountId,
  lenderKey,
  memoryStore,
  policy,
  providerAccountId,
  providerCallbackSecret,
  requirements,
  scanUrl,
  targetSha256,
} from "./helpers.js";

const now = new Date("2026-09-12T12:00:00.000Z");
const stores: SignerStore[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  stores.splice(0).forEach(store => store.close());
});

let proofPolicy: ProofPolicy;
let artifacts: ReturnType<typeof loadOfficialArtifacts>;
let poseidon: Awaited<ReturnType<typeof loadPoseidon>>;
beforeAll(async () => {
  poseidon = await loadPoseidon();
  artifacts = loadOfficialArtifacts();
  proofPolicy = new ProofPolicy({ poseidon, trusted: { verificationKey: artifacts.verificationKey, vkeyHash: artifacts.vkeyHash } });
});

const missionPolicy = (target = targetSha256) => policy("mission-1", { approvedRecipientsRoot: proofPolicy.rootFor(providerAccountId), targetSha256: target });
const proveFor = async (missionId: string, nonce: string, amount = "1000000", cap = 5_000_000n, recipient = providerAccountId, target = targetSha256) => {
  const challenge = normalizeChallenge(requirements({ amount, payTo: recipient }), missionId, target, nonce, { scanUrl });
  const witness = buildWitness({ capTinybar: cap, approvedRecipients: [recipient] }, challenge, poseidon);
  return { challenge, bundle: await prove(witness.input, artifacts) };
};
const zkGate = (store: SignerStore) => new PaymentGate({
  store, accountId: consumerAccountId, privateKey: consumerKey, network: "hedera:testnet", proofMode: "zk", proofPolicy, poseidon, now: () => now,
});

describe("restricted signer with real policy proofs", () => {
  it("signs only with a verified proof bound to the challenge, and the provider still accepts the authorization", async () => {
    const source = "pragma solidity ^0.8.24; contract Paid {}";
    const sourceSha256 = createHash("sha256").update(source, "utf8").digest("hex");
    const store = memoryStore();
    stores.push(store);
    store.registerMissionPolicy(missionPolicy(sourceSha256), now.toISOString(), account => proofPolicy.rootFor(account));
    const gate = zkGate(store);
    const { bundle } = await proveFor("mission-1", "1", "1000000", 5_000_000n, providerAccountId, sourceSha256);

    const response = await gate.authorize({ missionId: "mission-1", requirements: requirements(), nonce: "1", bundle });
    expect(response.paymentAuthorization.nonce).toBe("1");
    const attempt = validatePaidPaymentAttempt(
      { missionId: "mission-1", targetRef: "Paid.sol", source, targetSha256: sourceSha256, paymentAuthorization: response.paymentAuthorization },
      encodePaymentSignatureHeader({ x402Version: 2, accepted: requirements(), payload: { transaction: response.transaction } } as PaymentPayload),
      { providerAccountId, scanUrl, amountTinybar: "1000000", network: "hedera:testnet", asset: "0.0.0", feePayerAccountId, signerPublicKeys: { [consumerAccountId]: consumerKey.publicKey.toStringRaw() } },
      now,
    );
    expect(attempt.authorization).toEqual(response.paymentAuthorization);

    // Same valid proof, another nonce: the commitment no longer matches.
    await expect(gate.authorize({ missionId: "mission-1", requirements: requirements(), nonce: "2", bundle })).rejects.toMatchObject({ code: "challenge_binding_mismatch" });
    // A proof for the same challenge but made under a larger cap than the mission's is refused on the cap signal.
    const overCap = await proveFor("mission-1", "3", "1000000", 5_000_001n, providerAccountId, sourceSha256);
    await expect(gate.authorize({ missionId: "mission-1", requirements: requirements(), nonce: "3", bundle: overCap.bundle })).rejects.toMatchObject({ code: "cap_exceeded" });
    // A proof made against a tree that does not contain the mission's provider carries a foreign root.
    const otherTree = await proveFor("mission-1", "4", "1000000", 5_000_000n, "0.0.2002", sourceSha256);
    await expect(gate.authorize({ missionId: "mission-1", requirements: requirements({ payTo: "0.0.2002" }), nonce: "4", bundle: otherTree.bundle })).rejects.toMatchObject({ code: "recipient_not_approved" });
    // A proof forged for a different key hash is refused even though it verifies under the official key.
    await expect(gate.authorize({ missionId: "mission-1", requirements: requirements(), nonce: "5", bundle: { ...(await proveFor("mission-1", "5", "1000000", 5_000_000n, providerAccountId, sourceSha256)).bundle, vkeyHash: "a".repeat(64) } })).rejects.toMatchObject({ code: "proof_vkey_mismatch" });
  });

  it("serves the zk deployment over HTTP: pinned key in health, proof-bound acceptance and authorization", async () => {
    const store = memoryStore();
    stores.push(store);
    const confirmer = { confirm: vi.fn(async () => ({ settledAt: now.toISOString() })) };
    const credit = new CreditService({
      store, accountId: consumerAccountId, privateKey: consumerKey, lenderPublicKeys: { [lenderAccountId]: lenderKey.publicKey.toStringRaw() },
      confirmer, now: () => now.toISOString(), proofMode: "zk", proofPolicy,
    });
    const app = createSignerApp({
      store,
      gate: zkGate(store),
      credit,
      completion: new CompletionService({ store, accountId: consumerAccountId, providerCallbackSecrets: { "provider-a": providerCallbackSecret }, confirmer }),
      repayment: new RepaymentService({ store, accountId: consumerAccountId, ledger: { prepare: vi.fn(), submit: vi.fn() }, confirmer }),
      proofPolicy,
      credentials,
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>(resolve => server.once("listening", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = (path: string, body: unknown, token: string) => fetch(`${baseUrl}${path}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    });

    expect(await (await fetch(`${baseUrl}/health`)).json()).toEqual({ status: "ok", circuitId: "koven-policy-v1", vkeyHash: artifacts.vkeyHash });

    const wrongRoot = await post("/internal/missions/register", policy("mission-1", { approvedRecipientsRoot: "1" }), credentials.registrar);
    expect(wrongRoot.status).toBe(403);
    expect(await wrongRoot.json()).toMatchObject({ code: "mission_policy_mismatch" });
    expect((await post("/internal/missions/register", missionPolicy(), credentials.registrar)).status).toBe(200);

    // Credit acceptance carries the intent and its proof; both are checked against trusted policy.
    const request = { id: "credit-1", missionId: "mission-1", borrowerAccountId: consumerAccountId, principalTinybar: "3000000", requestedTermSeconds: 3600, purposeHash: purposeHashFor("mission-1", targetSha256), createdAt: now.toISOString() };
    expect((await post("/sign-credit-request", { request }, credentials.consumer)).status).toBe(200);
    const terms = { id: "offer-1", requestId: "credit-1", lenderAccountId, principalTinybar: "3000000", feeTinybar: "30000", termSeconds: 3600, expiresAt: "2026-09-12T12:05:00.000Z" };
    const unsigned = { ...terms, termsHash: termsHashFor(terms) };
    const offer = { ...unsigned, signature: signDomain(lenderKey, CREDIT_SIGNATURE_DOMAINS.offer, unsigned) };
    const { challenge, bundle } = await proveFor("mission-1", "9");
    const paymentIntent = { ...challenge, amountTinybar: challenge.amountTinybar.toString(10) };

    const noEvidence = await post("/sign-credit-acceptance", { offer }, credentials.consumer);
    expect(noEvidence.status).toBe(400);
    const foreignIntent = await post("/sign-credit-acceptance", { offer, paymentIntent: { ...paymentIntent, recipientAccountId: "0.0.2002" }, paymentProofBundle: bundle }, credentials.consumer);
    expect(foreignIntent.status).toBe(403);
    expect(await foreignIntent.json()).toMatchObject({ code: "mission_policy_mismatch" });
    const accepted = await post("/sign-credit-acceptance", { offer, paymentIntent, paymentProofBundle: bundle }, credentials.consumer);
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    const signed = await accepted.json() as { acceptance: { paymentIntentHash?: string; paymentProofBundleHash?: string } };
    expect(signed.acceptance.paymentIntentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.acceptance.paymentProofBundleHash).toMatch(/^[0-9a-f]{64}$/);

    // The same bound intent pays: /authorize verifies the same bundle.
    const authorized = await post("/authorize", { missionId: "mission-1", requirements: requirements(), nonce: "9", bundle }, credentials.consumer);
    expect(authorized.status, await authorized.clone().text()).toBe(200);
    const missingBundle = await post("/authorize", { missionId: "mission-1", requirements: requirements(), nonce: "10" }, credentials.consumer);
    expect(missingBundle.status).toBe(400);
    expect(await missingBundle.json()).toMatchObject({ code: "request_invalid" });
  });
});
