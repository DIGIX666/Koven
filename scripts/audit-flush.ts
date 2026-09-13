import { pathToFileURL } from "node:url";

import { HcsAuditWriter } from "@koven/audit";
import { HederaHcsPublisher } from "@koven/audit/node";
import { createClient } from "@koven/hedera";
import { openDatabase, SqliteAuditOutbox } from "@koven/persistence";
import { config as loadDotenv } from "dotenv";

const required = (source: NodeJS.ProcessEnv, key: string): string => {
  const value = source[key];
  if (!value) throw new Error(`Missing audit configuration: ${key}`);
  return value;
};

/** Flushes one service database and fails while any lifecycle attestation remains pending. */
export async function flushAuditOutbox(source: NodeJS.ProcessEnv = process.env): Promise<void> {
  const database = openDatabase(required(source, "DATABASE_URL"));
  const client = createClient({
    HEDERA_NETWORK: required(source, "HEDERA_NETWORK"),
    HEDERA_OPERATOR_ID: required(source, "HEDERA_OPERATOR_ID"),
    HEDERA_OPERATOR_PRIVATE_KEY: required(source, "HEDERA_OPERATOR_PRIVATE_KEY"),
  });
  try {
    const writer = new HcsAuditWriter({
      store: new SqliteAuditOutbox(database),
      publisher: new HederaHcsPublisher(client, required(source, "HCS_AUDIT_TOPIC_ID")),
    });
    const timeout = Number(source.AUDIT_FLUSH_TIMEOUT_MS ?? "30000");
    await writer.flush(timeout);
  } finally {
    try { database.close(); } finally { client.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadDotenv({ path: ".env" });
  await flushAuditOutbox();
}
