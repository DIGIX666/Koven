import type { AuditEvent, AuditSink } from "@koven/audit";

/** In-memory audit sink used until durable HCS publication is available. */
export class NoopAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  private nextFailure: Error | undefined;

  failNext(error = new Error("Injected audit failure")): void {
    this.nextFailure = error;
  }

  async write(event: AuditEvent): Promise<void> {
    if (this.nextFailure !== undefined) {
      const error = this.nextFailure;
      this.nextFailure = undefined;
      throw error;
    }
    this.events.push(structuredClone(event));
  }
}
