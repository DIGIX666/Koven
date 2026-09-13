import type { Server } from "node:http";
import { createClient, PrivateKey, PublicKey } from "@koven/hedera";
import { openDatabase } from "@koven/persistence";
import { loadPoseidon } from "@koven/x402";
import { AgentKitFundingGateway, FundingService, HttpLoanRegistrationClient, MirrorNodeFundingReconciler } from "./fund.js";
import { ConservativeLenderPolicy } from "./policies/conservative.js";
import { CompetitiveLenderPolicy } from "./policies/competitive.js";
import { createLenderApp } from "./server.js";
import { LenderStore } from "./store.js";
import { LenderProofVerifier, loadLenderVerification } from "./verify.js";

type Environment = Record<string, string | undefined>;

export async function createLenderRuntime(source: Environment) {
  const required = (key: string): string => {
    const value = source[key];
    if (!value) throw new Error(`Missing lender configuration: ${key}`);
    return value;
  };
  const port = Number(required("LENDER_PORT"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid lender port");
  const accountId = required("LENDER_ACCOUNT_ID");
  const key = PrivateKey.fromStringECDSA(required("LENDER_PRIVATE_KEY"));
  const borrower = required("CONSUMER_ACCOUNT_ID");
  const borrowerKey = PublicKey.fromString(required("CONSUMER_PUBLIC_KEY"));
  const policyName = required("LENDER_POLICY");
  if (policyName !== "conservative" && policyName !== "competitive") throw new Error("Invalid lender policy");
  const reputation = Number(required("LENDER_BORROWER_REPUTATION"));
  if (!Number.isFinite(reputation) || reputation < 0 || reputation > 1) throw new Error("Invalid borrower reputation");
  const verification = loadLenderVerification(source);
  const proofVerifier = verification.trusted === undefined ? undefined : new LenderProofVerifier({ poseidon: await loadPoseidon(), trusted: verification.trusted });
  const client = createClient({ HEDERA_NETWORK: "testnet", HEDERA_OPERATOR_ID: accountId, HEDERA_OPERATOR_PRIVATE_KEY: required("LENDER_PRIVATE_KEY") });
  let database: ReturnType<typeof openDatabase> | undefined;
  try {
    database = openDatabase(required("LENDER_DATABASE_URL"));
    const store = new LenderStore(database);
    const fundingService = new FundingService({ store, lenderAccountId: accountId,
      gateway: new AgentKitFundingGateway(client, accountId, new MirrorNodeFundingReconciler(required("HEDERA_MIRROR_NODE_URL"))),
      registrationClient: new HttpLoanRegistrationClient(required("SIGNER_URL"), required("LENDER_SIGNER_CREDENTIAL")),
    });
    const app = createLenderApp({ store, fundingService, lenderAccountId: accountId, lenderPrivateKey: key,
      policy: policyName === "conservative" ? new ConservativeLenderPolicy() : new CompetitiveLenderPolicy(),
      operatorCredential: required("LENDER_REGISTRAR_CREDENTIAL"),
      borrowerPublicKey: id => id === borrower ? borrowerKey : undefined, borrowerReputation: () => reputation,
      proofMode: verification.proofMode, ...(proofVerifier === undefined ? {} : { proofVerifier }),
    });
    return { port, accountId, listen: (): Promise<Server> => new Promise((resolve, reject) => {
      const server = app.listen(port, "127.0.0.1", () => resolve(server));
      server.once("error", reject);
    }), close: () => { try { if (database?.open) database.close(); } finally { client.close(); } } };
  } catch (error) {
    try { if (database?.open) database.close(); } finally { client.close(); }
    throw error;
  }
}
