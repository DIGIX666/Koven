import type { PaymentPayload, PaymentRequirements, SupportedResponse, VerifyResponse, SettleResponse } from "@x402/core/types";
import { explorerUrl } from "@koven/hedera";
import { ExactHederaScheme, createClientHederaSigner, PrivateKey, inspectHederaTransaction } from "@x402/hedera";
import { accountId, OperatorError } from "./hedera.js";

const AMOUNT = "1000000";
const JOURNAL = "KOVEN_X402_SMOKE_TX_ID";
const STATE = "KOVEN_X402_SMOKE_STATE";
interface Store { get(key: string): string; set(values: Record<string, string>): void; }
export interface SmokeConfig { consumer: string; provider: string; facilitatorUrl: string; mirrorUrl: string; }
interface Dependencies {
  facilitator: {
    getSupported(): Promise<SupportedResponse>;
    verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
    settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
  };
  build(requirements: PaymentRequirements): Promise<{ transactionId: string; payload: PaymentPayload }>;
  confirm(transactionId: string): Promise<void>;
}

export function smokeConfig(store: Pick<Store, "get">): SmokeConfig {
  if (store.get("HEDERA_NETWORK") !== "testnet" || store.get("X402_NETWORK") !== "hedera:testnet"
      || store.get("X402_ASSET") !== "0.0.0") throw new OperatorError("Smoke test requires testnet and the HBAR asset 0.0.0");
  // The signed payload is sent only to the facilitator under test.
  const facilitatorUrl = store.get("X402_FACILITATOR_URL");
  if (facilitatorUrl !== "https://api.testnet.blocky402.com") throw new OperatorError("Expected the Blocky402 testnet facilitator URL");
  const mirrorUrl = store.get("HEDERA_MIRROR_NODE_URL");
  if (mirrorUrl !== "https://testnet.mirrornode.hedera.com") throw new OperatorError("Expected the public testnet mirror for this smoke test");
  const consumer = accountId(store.get("CONSUMER_ACCOUNT_ID")).toString();
  const provider = accountId(store.get("PROVIDER_A_ACCOUNT_ID")).toString();
  if (consumer === provider) throw new OperatorError("Consumer and provider must be distinct");
  return { consumer, provider, facilitatorUrl, mirrorUrl };
}

export async function buildSmokePayment(config: SmokeConfig, privateKey: string, requirements: PaymentRequirements) {
  let key: PrivateKey;
  try { key = PrivateKey.fromStringECDSA(privateKey); }
  catch { throw new OperatorError("Invalid ECDSA consumer key"); }
  const signer = createClientHederaSigner(config.consumer, key, { network: "hedera:testnet" });
  const partial = await new ExactHederaScheme(signer).createPaymentPayload(2, requirements);
  if (typeof partial.payload.transaction !== "string") throw new OperatorError("Missing signed transaction");
  const tx = inspectHederaTransaction(partial.payload.transaction);
  const transfers = new Map(tx.hbarTransfers.map(entry => [entry.accountId, entry.amount]));
  if (tx.hasNonTransferOperations || Object.keys(tx.tokenTransfers).length !== 0
      || tx.hbarTransfers.length !== 2 || transfers.get(config.consumer) !== `-${AMOUNT}`
      || transfers.get(config.provider) !== AMOUNT
      || tx.transactionIdAccountId !== requirements.extra?.feePayer) {
    throw new OperatorError("Signed transaction does not match the smoke payment");
  }
  return { transactionId: tx.transactionId, payload: { ...partial, accepted: requirements } };
}

export async function runSmoke(config: SmokeConfig, store: Store, deps: Dependencies, reconcile?: string): Promise<void> {
  let stage = "reading the local journal";
  try {
    const saved = store.get(JOURNAL);
    if (saved && reconcile && saved !== reconcile) throw new OperatorError("Reconciliation ID conflicts with the saved payment");
    const previous = saved || reconcile;
    if (previous) {
      console.info(`Reconcile: ${explorerUrl(previous)}`);
      stage = "confirming the saved payment on the mirror";
      await deps.confirm(previous);
      store.set({ [JOURNAL]: previous, [STATE]: "confirmed" });
      console.info("Existing smoke payment confirmed; no new payment sent.");
      return;
    }
    if (store.get(STATE)) throw new OperatorError("Smoke journal is missing its transaction ID");
    stage = "reading /supported";
    const supported = await deps.facilitator.getSupported();
    const kinds = supported.kinds.filter(k => k.x402Version === 2 && k.scheme === "exact" && k.network === "hedera:testnet");
    if (kinds.length !== 1 || typeof kinds[0]!.extra?.feePayer !== "string") throw new OperatorError("Expected one exact Hedera testnet scheme with a fee payer");
    const feePayer = accountId(kinds[0]!.extra!.feePayer as string).toString();
    if ([config.consumer, config.provider].includes(feePayer)) throw new OperatorError("Fee payer must be distinct from the payment parties");
    const requirements: PaymentRequirements = { scheme: "exact", network: "hedera:testnet", asset: "0.0.0",
      amount: AMOUNT, payTo: config.provider, maxTimeoutSeconds: 180, extra: { feePayer } };
    stage = "building the payment";
    const payment = await deps.build(requirements);
    explorerUrl(payment.transactionId);
    if (!payment.transactionId.startsWith(`${feePayer}@`)) throw new OperatorError("Payment transaction ID does not use the advertised fee payer");
    stage = "verifying the payment";
    const verification = await deps.facilitator.verify(payment.payload, requirements);
    if (verification.isValid !== true || verification.payer !== config.consumer) throw new OperatorError("Blocky402 verification failed or returned a different payer");
    // Retain the public ID before the only state-changing facilitator request.
    store.set({ [JOURNAL]: payment.transactionId, [STATE]: "pending" });
    console.info(`Payment: ${explorerUrl(payment.transactionId)}`);
    stage = "settling the payment";
    const settlement = await deps.facilitator.settle(payment.payload, requirements);
    if (settlement.success !== true || settlement.transaction !== payment.transactionId
        || settlement.network !== "hedera:testnet" || settlement.payer !== config.consumer) {
      throw new OperatorError("Blocky402 settlement response does not confirm the expected payment; journal retained");
    }
    stage = "confirming settlement on the mirror";
    await deps.confirm(payment.transactionId);
    store.set({ [STATE]: "confirmed" });
    console.info("SUCCESS: 1000000 tinybars settled and independently confirmed.");
  } catch (error) {
    if (error instanceof OperatorError) throw error;
    throw new OperatorError(`Smoke test failed while ${stage}; check the saved transaction before retrying.`);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OperatorError("Invalid mirror response");
  return value as Record<string, unknown>;
}

export function assertMirrorPayment(body: unknown, config: SmokeConfig, transactionId: string): void {
  explorerUrl(transactionId);
  const mirrorId = transactionId.replace("@", "-").replace(/\.(\d{9})$/, "-$1");
  const rows = object(body).transactions;
  if (!Array.isArray(rows)) throw new OperatorError("Missing mirror transaction list");
  const successes = rows.map(object).filter(row => row.transaction_id === mirrorId && row.result === "SUCCESS"
    && row.name === "CRYPTOTRANSFER" && row.nonce === 0 && row.scheduled === false);
  if (successes.length !== 1) throw new OperatorError("Mirror has not confirmed the expected transfer");
  const tx = successes[0]!;
  if (!Array.isArray(tx.token_transfers) || tx.token_transfers.length || !Array.isArray(tx.nft_transfers)
      || tx.nft_transfers.length || !Array.isArray(tx.transfers)) throw new OperatorError("Unexpected mirror transfer shape");
  const net = new Map<string, bigint>();
  for (const entry of tx.transfers) {
    const transfer = object(entry);
    if (typeof transfer.account !== "string" || typeof transfer.amount !== "number"
        || !Number.isSafeInteger(transfer.amount) || transfer.is_approval !== false) throw new OperatorError("Invalid mirror transfer entry");
    accountId(transfer.account);
    net.set(transfer.account, (net.get(transfer.account) ?? 0n) + BigInt(transfer.amount));
  }
  const feePayer = transactionId.split("@")[0]!;
  if ([config.consumer, config.provider].includes(feePayer) || net.get(config.consumer) !== -BigInt(AMOUNT)
      || net.get(config.provider) !== BigInt(AMOUNT)
      || [...net].some(([id, amount]) => amount < 0n && id !== config.consumer && id !== feePayer)
      || [...net.values()].reduce((sum, amount) => sum + amount, 0n) !== 0n) {
    throw new OperatorError("Mirror payment amounts or parties do not match the smoke test");
  }
}

export async function confirmOnMirror(config: SmokeConfig, transactionId: string): Promise<void> {
  explorerUrl(transactionId);
  const id = transactionId.replace("@", "-").replace(/\.(\d{9})$/, "-$1");
  const response = await fetch(`${config.mirrorUrl}/api/v1/transactions/${id}`, { signal: AbortSignal.timeout(15_000), redirect: "error" });
  if (!response.ok) throw new OperatorError(`Mirror HTTP ${response.status}; journal retained for a later reconciliation`);
  assertMirrorPayment(await response.json(), config, transactionId);
}
