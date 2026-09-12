import type { Server } from "node:http";

import { createClient } from "@koven/hedera";
import { loadPoseidon } from "@koven/x402";

import { CompletionService } from "./completion.js";
import { loadSignerConfig } from "./config.js";
import { CreditService } from "./credit.js";
import { PaymentGate } from "./gate.js";
import { MirrorTransferConfirmer } from "./ledger.js";
import { RepaymentService, SdkRepaymentLedger } from "./repay.js";
import { createSignerApp } from "./server.js";
import { SignerStore } from "./store.js";

type EnvironmentSource = Record<string, string | undefined>;

export interface SignerRuntime {
  readonly host: string;
  readonly port: number;
  readonly store: SignerStore;
  listen(): Promise<Server>;
  close(): void;
}

/** Composes the only process that holds the consumer key. */
export async function createSignerRuntime(source: EnvironmentSource = process.env): Promise<SignerRuntime> {
  const config = loadSignerConfig(source);
  const store = new SignerStore(config.databasePath);
  const client = createClient({
    HEDERA_NETWORK: "testnet",
    HEDERA_OPERATOR_ID: config.accountId,
    HEDERA_OPERATOR_PRIVATE_KEY: config.privateKeyText,
  });
  try {
    const confirmer = new MirrorTransferConfirmer({ mirrorNodeUrl: config.mirrorNodeUrl });
    const app = createSignerApp({
      store,
      gate: new PaymentGate({
        store,
        accountId: config.accountId,
        privateKey: config.privateKey,
        network: config.network,
        poseidon: await loadPoseidon(),
      }),
      credit: new CreditService({
        store,
        accountId: config.accountId,
        privateKey: config.privateKey,
        lenderPublicKeys: config.lenderPublicKeys,
        confirmer,
      }),
      completion: new CompletionService({
        store,
        accountId: config.accountId,
        providerCallbackSecrets: config.providerCallbackSecrets,
        confirmer,
      }),
      repayment: new RepaymentService({
        store,
        accountId: config.accountId,
        ledger: new SdkRepaymentLedger(client, config.accountId, config.privateKey),
        confirmer,
      }),
      credentials: config.credentials,
    });
    return {
      host: config.host,
      port: config.port,
      store,
      async listen(): Promise<Server> {
        const listener = app.listen(config.port, config.host);
        await new Promise<void>((resolve, reject) => {
          listener.once("listening", resolve);
          listener.once("error", reject);
        });
        return listener;
      },
      close(): void {
        client.close();
        store.close();
      },
    };
  } catch (error) {
    client.close();
    store.close();
    throw error;
  }
}
