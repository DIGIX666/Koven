import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

export const REDACTION_CENSOR = "[REDACTED]";

/** Known secret-bearing fields at log boundaries, including child bindings. */
export const SENSITIVE_LOG_PATHS = [
  "privateKey", "*.privateKey", "*.*.privateKey",
  "private_key", "*.private_key", "*.*.private_key",
  "CONSUMER_PRIVATE_KEY", "*.CONSUMER_PRIVATE_KEY",
  "HEDERA_OPERATOR_PRIVATE_KEY", "*.HEDERA_OPERATOR_PRIVATE_KEY",
  "LENDER_A_PRIVATE_KEY", "*.LENDER_A_PRIVATE_KEY",
  "LENDER_B_PRIVATE_KEY", "*.LENDER_B_PRIVATE_KEY",
  "signature", "*.signature", "*.*.signature",
  "transaction", "*.transaction", "*.*.transaction",
  "transactionBytes", "*.transactionBytes", "*.*.transactionBytes",
] as const;

export interface CreateLoggerOptions {
  name?: string;
  level?: string;
  destination?: DestinationStream;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const loggerOptions: LoggerOptions = {
    level: options.level ?? "info",
    redact: { paths: [...SENSITIVE_LOG_PATHS], censor: REDACTION_CENSOR },
  };
  if (options.name !== undefined) loggerOptions.name = options.name;

  return options.destination === undefined
    ? pino(loggerOptions)
    : pino(loggerOptions, options.destination);
}
