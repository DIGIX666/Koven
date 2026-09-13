import {
  HcsAuditWriter,
  type AuditSink,
  type HcsPublisher,
} from "@koven/audit";
import { SqliteAuditOutbox, type KovenDatabase } from "@koven/persistence";

export interface OrchestratorAuditRuntime {
  readonly sink: AuditSink;
  start(): void;
  flush(timeoutMs?: number): Promise<void>;
  stop(): void;
}

class NoopAuditRuntime implements OrchestratorAuditRuntime {
  readonly sink: AuditSink = { write: async () => undefined };
  start(): void {}
  async flush(): Promise<void> {}
  stop(): void {}
}

/** Selects the offline sink or the durable HCS worker at the composition root. */
export function createOrchestratorAuditRuntime(options: {
  database: KovenDatabase;
  mode: "noop" | "hcs";
  publisher?: HcsPublisher;
}): OrchestratorAuditRuntime {
  if (options.mode === "noop") return new NoopAuditRuntime();
  if (options.publisher === undefined) throw new Error("AUDIT_SINK=hcs requires an HCS publisher");
  const writer = new HcsAuditWriter({
    store: new SqliteAuditOutbox(options.database),
    publisher: options.publisher,
  });
  return {
    sink: writer,
    start: () => writer.start(),
    flush: timeoutMs => writer.flush(timeoutMs),
    stop: () => writer.stop(),
  };
}
