import { z } from "zod";

type EnvironmentSource = Record<string, string | undefined>;

const emptyAsMissing = (value: unknown) => value === "" ? undefined : value;
const requiredString = z.preprocess(emptyAsMissing, z.string().min(1));
const accountId = z.preprocess(
  emptyAsMissing,
  z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
);
const url = z.preprocess(emptyAsMissing, z.string().url());
const port = z.preprocess(emptyAsMissing, z.coerce.number().int().min(1).max(65_535));
const decimal = z.preprocess(emptyAsMissing, z.string().regex(/^(0|[1-9]\d*)$/));
const hbarAsset = z.preprocess(value => value === "HBAR" ? "0.0.0" : value, z.literal("0.0.0"));

const fields = {
  HEDERA_NETWORK: z.literal("testnet"),
  HEDERA_OPERATOR_ID: accountId,
  HEDERA_OPERATOR_PRIVATE_KEY: requiredString,
  HEDERA_MIRROR_NODE_URL: url,
  X402_NETWORK: z.literal("hedera:testnet"),
  X402_FACILITATOR_URL: url,
  X402_PAY_TO_ACCOUNT_ID: accountId,
  X402_ASSET: hbarAsset,
  CONSUMER_ACCOUNT_ID: accountId,
  CONSUMER_PRIVATE_KEY: requiredString,
  LENDER_A_ACCOUNT_ID: accountId,
  LENDER_A_PRIVATE_KEY: requiredString,
  LENDER_B_ACCOUNT_ID: accountId,
  LENDER_B_PRIVATE_KEY: requiredString,
  HCS_AUDIT_TOPIC_ID: accountId,
  DEFAULT_MISSION_SPENDING_CAP: decimal,
  APPROVED_RECIPIENTS_ROOT: decimal,
  WEB_PORT: port,
  ORCHESTRATOR_PORT: port,
  DIRECTORY_PORT: port,
  RESOURCE_SERVER_PORT: port,
  RESTRICTED_SIGNER_PORT: port,
  DATABASE_URL: requiredString,
} as const;

const schema = <K extends keyof typeof fields>(...keys: K[]) => z.object(
  Object.fromEntries(keys.map(key => [key, fields[key]])) as Pick<typeof fields, K>,
);

const signerSchema = schema(
  "HEDERA_NETWORK", "HEDERA_MIRROR_NODE_URL", "X402_NETWORK", "CONSUMER_ACCOUNT_ID",
  "CONSUMER_PRIVATE_KEY", "RESTRICTED_SIGNER_PORT", "DATABASE_URL",
  "DEFAULT_MISSION_SPENDING_CAP", "APPROVED_RECIPIENTS_ROOT",
);
const orchestratorSchema = schema(
  "CONSUMER_ACCOUNT_ID", "ORCHESTRATOR_PORT", "DIRECTORY_PORT", "RESOURCE_SERVER_PORT",
  "RESTRICTED_SIGNER_PORT", "DATABASE_URL",
);
const consumerSchema = schema(
  "X402_NETWORK", "CONSUMER_ACCOUNT_ID", "RESOURCE_SERVER_PORT", "RESTRICTED_SIGNER_PORT",
);
const resourceServerSchema = schema(
  "X402_NETWORK", "X402_FACILITATOR_URL", "X402_PAY_TO_ACCOUNT_ID", "X402_ASSET",
  "RESOURCE_SERVER_PORT",
);
const directorySchema = schema("DIRECTORY_PORT", "DATABASE_URL");
const webSchema = schema("WEB_PORT", "ORCHESTRATOR_PORT", "DIRECTORY_PORT");
const operatorSchema = schema(
  "HEDERA_NETWORK", "HEDERA_OPERATOR_ID", "HEDERA_OPERATOR_PRIVATE_KEY",
  "HEDERA_MIRROR_NODE_URL", "HCS_AUDIT_TOPIC_ID",
);

export class EnvironmentValidationError extends Error {
  readonly keys: readonly string[];

  constructor(keys: readonly string[]) {
    super(`Invalid environment variables: ${keys.join(", ")}`);
    this.name = "EnvironmentValidationError";
    this.keys = keys;
  }
}

function parseEnvironment<S extends z.ZodTypeAny>(schemaToParse: S, source: EnvironmentSource): z.infer<S> {
  const result = schemaToParse.safeParse(source);
  if (result.success) return result.data;

  const keys = [...new Set(result.error.issues.map(issue => String(issue.path[0] ?? "environment")))].sort();
  throw new EnvironmentValidationError(keys);
}

export interface SignerEnv {
  network: "testnet";
  x402Network: "hedera:testnet";
  accountId: string;
  privateKey: string;
  mirrorNodeUrl: string;
  port: number;
  databaseUrl: string;
  defaultMissionSpendingCap: string;
  approvedRecipientsRoot: string;
}

export interface OrchestratorEnv {
  consumerAccountId: string;
  port: number;
  directoryPort: number;
  resourceServerPort: number;
  restrictedSignerPort: number;
  databaseUrl: string;
}

export interface ConsumerEnv {
  accountId: string;
  x402Network: "hedera:testnet";
  resourceServerPort: number;
  restrictedSignerPort: number;
}

export interface LenderEnv {
  network: "testnet";
  accountId: string;
  privateKey: string;
  consumerAccountId: string;
  mirrorNodeUrl: string;
  auditTopicId: string;
}

export interface ResourceServerEnv {
  network: "hedera:testnet";
  facilitatorUrl: string;
  payToAccountId: string;
  asset: "0.0.0";
  port: number;
}

export interface DirectoryEnv {
  port: number;
  databaseUrl: string;
}

export interface WebEnv {
  port: number;
  orchestratorPort: number;
  directoryPort: number;
}

export interface OperatorEnv {
  network: "testnet";
  accountId: string;
  privateKey: string;
  mirrorNodeUrl: string;
  auditTopicId: string;
}

/** Validates only the variables required by the restricted signer. */
export function loadSignerEnv(source: EnvironmentSource = process.env): SignerEnv {
  const env = parseEnvironment(signerSchema, source);
  return Object.freeze({
    network: env.HEDERA_NETWORK,
    x402Network: env.X402_NETWORK,
    accountId: env.CONSUMER_ACCOUNT_ID,
    privateKey: env.CONSUMER_PRIVATE_KEY,
    mirrorNodeUrl: env.HEDERA_MIRROR_NODE_URL,
    port: env.RESTRICTED_SIGNER_PORT,
    databaseUrl: env.DATABASE_URL,
    defaultMissionSpendingCap: env.DEFAULT_MISSION_SPENDING_CAP,
    approvedRecipientsRoot: env.APPROVED_RECIPIENTS_ROOT,
  });
}

export function loadOrchestratorEnv(source: EnvironmentSource = process.env): OrchestratorEnv {
  const env = parseEnvironment(orchestratorSchema, source);
  return Object.freeze({
    consumerAccountId: env.CONSUMER_ACCOUNT_ID,
    port: env.ORCHESTRATOR_PORT,
    directoryPort: env.DIRECTORY_PORT,
    resourceServerPort: env.RESOURCE_SERVER_PORT,
    restrictedSignerPort: env.RESTRICTED_SIGNER_PORT,
    databaseUrl: env.DATABASE_URL,
  });
}

export function loadConsumerEnv(source: EnvironmentSource = process.env): ConsumerEnv {
  const env = parseEnvironment(consumerSchema, source);
  return Object.freeze({
    accountId: env.CONSUMER_ACCOUNT_ID,
    x402Network: env.X402_NETWORK,
    resourceServerPort: env.RESOURCE_SERVER_PORT,
    restrictedSignerPort: env.RESTRICTED_SIGNER_PORT,
  });
}

export function loadLenderEnv(lender: "A" | "B", source: EnvironmentSource = process.env): LenderEnv {
  const commonKeys = [
    "HEDERA_NETWORK", "CONSUMER_ACCOUNT_ID", "HEDERA_MIRROR_NODE_URL", "HCS_AUDIT_TOPIC_ID",
  ] as const;
  if (lender === "A") {
    const env = parseEnvironment(
      schema(...commonKeys, "LENDER_A_ACCOUNT_ID", "LENDER_A_PRIVATE_KEY"),
      source,
    );
    return Object.freeze({
      network: env.HEDERA_NETWORK,
      accountId: env.LENDER_A_ACCOUNT_ID,
      privateKey: env.LENDER_A_PRIVATE_KEY,
      consumerAccountId: env.CONSUMER_ACCOUNT_ID,
      mirrorNodeUrl: env.HEDERA_MIRROR_NODE_URL,
      auditTopicId: env.HCS_AUDIT_TOPIC_ID,
    });
  }

  const env = parseEnvironment(
    schema(...commonKeys, "LENDER_B_ACCOUNT_ID", "LENDER_B_PRIVATE_KEY"),
    source,
  );
  return Object.freeze({
    network: env.HEDERA_NETWORK,
    accountId: env.LENDER_B_ACCOUNT_ID,
    privateKey: env.LENDER_B_PRIVATE_KEY,
    consumerAccountId: env.CONSUMER_ACCOUNT_ID,
    mirrorNodeUrl: env.HEDERA_MIRROR_NODE_URL,
    auditTopicId: env.HCS_AUDIT_TOPIC_ID,
  });
}

export function loadResourceServerEnv(source: EnvironmentSource = process.env): ResourceServerEnv {
  const env = parseEnvironment(resourceServerSchema, source);
  return Object.freeze({
    network: env.X402_NETWORK,
    facilitatorUrl: env.X402_FACILITATOR_URL,
    payToAccountId: env.X402_PAY_TO_ACCOUNT_ID,
    asset: env.X402_ASSET,
    port: env.RESOURCE_SERVER_PORT,
  });
}

export function loadDirectoryEnv(source: EnvironmentSource = process.env): DirectoryEnv {
  const env = parseEnvironment(directorySchema, source);
  return Object.freeze({ port: env.DIRECTORY_PORT, databaseUrl: env.DATABASE_URL });
}

export function loadWebEnv(source: EnvironmentSource = process.env): WebEnv {
  const env = parseEnvironment(webSchema, source);
  return Object.freeze({
    port: env.WEB_PORT,
    orchestratorPort: env.ORCHESTRATOR_PORT,
    directoryPort: env.DIRECTORY_PORT,
  });
}

export function loadOperatorEnv(source: EnvironmentSource = process.env): OperatorEnv {
  const env = parseEnvironment(operatorSchema, source);
  return Object.freeze({
    network: env.HEDERA_NETWORK,
    accountId: env.HEDERA_OPERATOR_ID,
    privateKey: env.HEDERA_OPERATOR_PRIVATE_KEY,
    mirrorNodeUrl: env.HEDERA_MIRROR_NODE_URL,
    auditTopicId: env.HCS_AUDIT_TOPIC_ID,
  });
}
