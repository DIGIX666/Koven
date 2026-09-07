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

const environmentSchema = z.object({
  HEDERA_NETWORK: z.literal("testnet"),
  HEDERA_OPERATOR_ID: accountId,
  HEDERA_OPERATOR_PRIVATE_KEY: requiredString,
  HEDERA_MIRROR_NODE_URL: url,
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
});

type Environment = z.infer<typeof environmentSchema>;

export class EnvironmentValidationError extends Error {
  readonly keys: readonly string[];

  constructor(keys: readonly string[]) {
    super(`Invalid environment variables: ${keys.join(", ")}`);
    this.name = "EnvironmentValidationError";
    this.keys = keys;
  }
}

function parseEnvironment(source: EnvironmentSource): Environment {
  const result = environmentSchema.safeParse(source);
  if (result.success) return result.data;

  const keys = [...new Set(result.error.issues.map(issue => String(issue.path[0] ?? "environment")))].sort();
  throw new EnvironmentValidationError(keys);
}

export interface SignerEnv {
  network: "testnet";
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

/** Parse the complete environment once at restricted-signer process startup. */
export function loadSignerEnv(source: EnvironmentSource = process.env): SignerEnv {
  const env = parseEnvironment(source);
  return Object.freeze({
    network: env.HEDERA_NETWORK,
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
  const env = parseEnvironment(source);
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
  const env = parseEnvironment(source);
  return Object.freeze({
    accountId: env.CONSUMER_ACCOUNT_ID,
    resourceServerPort: env.RESOURCE_SERVER_PORT,
    restrictedSignerPort: env.RESTRICTED_SIGNER_PORT,
  });
}

export function loadLenderEnv(lender: "A" | "B", source: EnvironmentSource = process.env): LenderEnv {
  const env = parseEnvironment(source);
  return Object.freeze({
    network: env.HEDERA_NETWORK,
    accountId: lender === "A" ? env.LENDER_A_ACCOUNT_ID : env.LENDER_B_ACCOUNT_ID,
    privateKey: lender === "A" ? env.LENDER_A_PRIVATE_KEY : env.LENDER_B_PRIVATE_KEY,
    consumerAccountId: env.CONSUMER_ACCOUNT_ID,
    mirrorNodeUrl: env.HEDERA_MIRROR_NODE_URL,
    auditTopicId: env.HCS_AUDIT_TOPIC_ID,
  });
}

export function loadResourceServerEnv(source: EnvironmentSource = process.env): ResourceServerEnv {
  const env = parseEnvironment(source);
  return Object.freeze({
    facilitatorUrl: env.X402_FACILITATOR_URL,
    payToAccountId: env.X402_PAY_TO_ACCOUNT_ID,
    asset: env.X402_ASSET,
    port: env.RESOURCE_SERVER_PORT,
  });
}

export function loadDirectoryEnv(source: EnvironmentSource = process.env): DirectoryEnv {
  const env = parseEnvironment(source);
  return Object.freeze({ port: env.DIRECTORY_PORT, databaseUrl: env.DATABASE_URL });
}

export function loadWebEnv(source: EnvironmentSource = process.env): WebEnv {
  const env = parseEnvironment(source);
  return Object.freeze({
    port: env.WEB_PORT,
    orchestratorPort: env.ORCHESTRATOR_PORT,
    directoryPort: env.DIRECTORY_PORT,
  });
}

export function loadOperatorEnv(source: EnvironmentSource = process.env): OperatorEnv {
  const env = parseEnvironment(source);
  return Object.freeze({
    network: env.HEDERA_NETWORK,
    accountId: env.HEDERA_OPERATOR_ID,
    privateKey: env.HEDERA_OPERATOR_PRIVATE_KEY,
    mirrorNodeUrl: env.HEDERA_MIRROR_NODE_URL,
    auditTopicId: env.HCS_AUDIT_TOPIC_ID,
  });
}
