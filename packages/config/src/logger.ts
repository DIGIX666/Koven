import pino, {
  type Bindings,
  type ChildLoggerOptions,
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from "pino";

export const REDACTION_CENSOR = "[REDACTED]";

const sensitiveKey = (key: string): boolean => {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized.includes("privatekey")
    || normalized.includes("signature")
    || normalized === "transaction"
    || normalized.includes("transactionbytes")
    || normalized.includes("signedtransaction");
};

/** Recursively censors secret-bearing keys in log objects and child bindings. */
function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";

  seen.add(value);
  if (Array.isArray(value)) {
    const sanitized = value.map(item => sanitize(item, seen));
    seen.delete(value);
    return sanitized;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    seen.delete(value);
    return value;
  }
  const sanitized = Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    sensitiveKey(key) ? REDACTION_CENSOR : sanitize(nested, seen),
  ]));
  seen.delete(value);
  return sanitized;
}

const sanitizeRecord = (value: Record<string, unknown>): Record<string, unknown> => (
  sanitize(value) as Record<string, unknown>
);

function protectChildBindings(logger: Logger): Logger {
  const createChild = logger.child.bind(logger);
  logger.child = ((bindings: Bindings, options?: ChildLoggerOptions) => (
    protectChildBindings(createChild(sanitizeRecord(bindings), options))
  )) as unknown as Logger["child"];
  return logger;
}

export interface CreateLoggerOptions {
  name?: string;
  level?: string;
  destination?: DestinationStream;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const loggerOptions: LoggerOptions = {
    level: options.level ?? "info",
    formatters: {
      bindings: sanitizeRecord,
      log: sanitizeRecord,
    },
  };
  if (options.name !== undefined) loggerOptions.name = options.name;

  const logger = options.destination === undefined
    ? pino(loggerOptions)
    : pino(loggerOptions, options.destination);
  return protectChildBindings(logger);
}
