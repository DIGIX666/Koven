import type { Server } from "node:http";

import { loadPaidScanEnvironment } from "./config.js";
import { ProviderStore } from "./outbox.js";
import { createPaidScanServer, type PaidScanServer } from "./server.js";
import { MirrorSettlementConfirmer } from "./settlement.js";

type EnvironmentSource = Record<string, string | undefined>;

export interface PaidScanRuntime extends PaidScanServer {
  readonly port: number;
  readonly store: ProviderStore;
  listen(): Promise<Server>;
  close(): void;
}

/** Composes production adapters while keeping private consumer keys out of this process. */
export async function createPaidScanRuntime(
  source: EnvironmentSource = process.env,
): Promise<PaidScanRuntime> {
  const config = loadPaidScanEnvironment(source);
  const store = new ProviderStore(config.databasePath);
  try {
    const server = await createPaidScanServer({
      providerId: config.providerId,
      providerAccountId: config.providerAccountId,
      scanUrl: config.scanUrl,
      amountTinybar: config.amountTinybar,
      network: config.network,
      asset: config.asset,
      signerPublicKeys: config.signerPublicKeys,
      facilitatorUrl: config.facilitatorUrl,
      store,
      settlementConfirmer: new MirrorSettlementConfirmer({ mirrorNodeUrl: config.mirrorNodeUrl }),
      callbackUrl: config.callbackUrl,
      callbackSecret: config.callbackSecret,
    });
    return {
      ...server,
      port: config.port,
      store,
      async listen(): Promise<Server> {
        const listener = server.app.listen(config.port, "127.0.0.1");
        await new Promise<void>((resolve, reject) => {
          listener.once("listening", resolve);
          listener.once("error", reject);
        });
        return listener;
      },
      close(): void {
        server.callbacks.stop();
        server.settlements.stop();
        store.close();
      },
    };
  } catch (error) {
    store.close();
    throw error;
  }
}
