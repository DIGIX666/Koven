import type { Provider } from "@koven/domain";
import { ProviderSchema } from "@koven/schemas";
import { z } from "zod";

const ProviderRecordSchema = ProviderSchema.omit({ reputationScore: true });
const ProviderRecordsSchema = z.array(ProviderRecordSchema);

export type ProviderRecord = Omit<Provider, "reputationScore">;

/** Immutable provider metadata. Reputation is deliberately absent and computed from events. */
export class ProviderRegistry {
  private readonly providers: readonly ProviderRecord[];

  constructor(records: unknown) {
    const parsed = ProviderRecordsSchema.parse(records);
    const ids = new Set(parsed.map(record => record.id));
    if (ids.size !== parsed.length) throw new Error("Provider ids must be unique");
    this.providers = parsed
      .map(record => ({ ...record, priceTinybar: BigInt(record.priceTinybar) }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  list(): ProviderRecord[] {
    return this.providers.map(provider => ({ ...provider }));
  }
}
