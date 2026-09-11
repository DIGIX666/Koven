import { canonicalHash, CreditProtocolError } from "@koven/credit-protocol";
import { ErrorCode, type CreditOffer, type CreditRequest } from "@koven/domain";
import type { KovenDatabase } from "@koven/persistence";
import type { HttpRequest } from "@koven/schemas";

export type MissionPolicy = HttpRequest<"registerMissionPolicy">;

export interface FundingRecord {
  id: string;
  offerId: string;
  acceptanceHash: string;
  acceptanceJson: string;
  transactionId?: string;
  status: "reserved" | "preparing" | "pending" | "confirmed" | "registered";
}

interface StoredOffer {
  request: CreditRequest;
  offer: CreditOffer;
}

const requestToJson = (request: CreditRequest) => JSON.stringify({
  ...request,
  principalTinybar: request.principalTinybar.toString(10),
});

const requestFromJson = (value: string): CreditRequest => {
  const parsed = JSON.parse(value) as Omit<CreditRequest, "principalTinybar"> & {
    principalTinybar: string;
  };
  return { ...parsed, principalTinybar: BigInt(parsed.principalTinybar) };
};

const offerToJson = (offer: CreditOffer) => JSON.stringify({
  ...offer,
  principalTinybar: offer.principalTinybar.toString(10),
  feeTinybar: offer.feeTinybar.toString(10),
});

const offerFromJson = (value: string): CreditOffer => {
  const parsed = JSON.parse(value) as Omit<CreditOffer, "principalTinybar" | "feeTinybar"> & {
    principalTinybar: string;
    feeTinybar: string;
  };
  return {
    ...parsed,
    principalTinybar: BigInt(parsed.principalTinybar),
    feeTinybar: BigInt(parsed.feeTinybar),
  };
};

/** Lender-owned tables stay inside the lender's private database instance. */
export class LenderStore {
  constructor(private readonly database: KovenDatabase) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS lender_mission_policies (
        mission_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS lender_offers (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        offer_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS lender_fundings (
        id TEXT PRIMARY KEY,
        offer_id TEXT NOT NULL UNIQUE,
        acceptance_hash TEXT NOT NULL,
        acceptance_json TEXT NOT NULL,
        transaction_id TEXT UNIQUE,
        submission_token TEXT,
        status TEXT NOT NULL CHECK (
          status IN ('reserved', 'preparing', 'pending', 'confirmed', 'registered')
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS lender_registration_outbox (
        funding_id TEXT PRIMARY KEY REFERENCES lender_fundings(id),
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        delivered_at TEXT,
        last_error TEXT
      ) STRICT;
    `);
  }

  registerMissionPolicy(policy: MissionPolicy, now: string): "registered" | "duplicate" {
    const contentHash = canonicalHash(policy);
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO lender_mission_policies (
        mission_id, content_hash, policy_json, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(policy.missionId, contentHash, JSON.stringify(policy), now);
    if (result.changes === 1) return "registered";

    const existing = this.database.prepare(`
      SELECT content_hash FROM lender_mission_policies WHERE mission_id = ?
    `).get(policy.missionId) as { content_hash: string } | undefined;
    if (existing?.content_hash === contentHash) return "duplicate";
    throw new CreditProtocolError(
      ErrorCode.MISSION_POLICY_CONFLICT,
      "Mission policy already exists with different content",
    );
  }

  getMissionPolicy(missionId: string): MissionPolicy | undefined {
    const row = this.database.prepare(`
      SELECT policy_json FROM lender_mission_policies WHERE mission_id = ?
    `).get(missionId) as { policy_json: string } | undefined;
    return row === undefined ? undefined : JSON.parse(row.policy_json) as MissionPolicy;
  }

  saveOffer(request: CreditRequest, offer: CreditOffer, now: string): CreditOffer {
    const requestHash = canonicalHash(request);
    try {
      this.database.prepare(`
        INSERT INTO lender_offers (
          id, request_id, request_hash, request_json, offer_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(offer.id, request.id, requestHash, requestToJson(request), offerToJson(offer), now);
      return offer;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error)
        || !String(error.code).startsWith("SQLITE_CONSTRAINT")) throw error;
      const existing = this.getOfferByRequest(request.id);
      if (existing !== undefined && canonicalHash(existing.request) === requestHash) {
        return existing.offer;
      }
      throw new CreditProtocolError(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        "Credit request ID was reused with different signed content",
      );
    }
  }

  getOffer(id: string): StoredOffer | undefined {
    const row = this.database.prepare(`
      SELECT request_json, offer_json FROM lender_offers WHERE id = ?
    `).get(id) as { request_json: string; offer_json: string } | undefined;
    return row === undefined ? undefined : {
      request: requestFromJson(row.request_json),
      offer: offerFromJson(row.offer_json),
    };
  }

  private getOfferByRequest(requestId: string): StoredOffer | undefined {
    const row = this.database.prepare(`
      SELECT request_json, offer_json FROM lender_offers WHERE request_id = ?
    `).get(requestId) as { request_json: string; offer_json: string } | undefined;
    return row === undefined ? undefined : {
      request: requestFromJson(row.request_json),
      offer: offerFromJson(row.offer_json),
    };
  }

  reserveFunding(
    offerId: string,
    acceptanceHash: string,
    acceptanceJson: string,
    now: string,
  ): FundingRecord {
    const existing = this.getFundingByOffer(offerId);
    if (existing !== undefined) {
      if (existing.acceptanceHash === acceptanceHash) return existing;
      throw new CreditProtocolError(
        ErrorCode.CREDIT_ACCEPTANCE_CONFLICT,
        "Offer was already accepted with different content",
      );
    }
    const id = `funding-${canonicalHash({ offerId }).slice(0, 32)}`;
    try {
      this.database.prepare(`
        INSERT INTO lender_fundings (
          id, offer_id, acceptance_hash, acceptance_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'reserved', ?, ?)
      `).run(id, offerId, acceptanceHash, acceptanceJson, now, now);
    } catch (error) {
      const concurrent = this.getFundingByOffer(offerId);
      if (concurrent?.acceptanceHash === acceptanceHash) return concurrent;
      if (concurrent !== undefined) {
        throw new CreditProtocolError(
          ErrorCode.CREDIT_ACCEPTANCE_CONFLICT,
          "Offer was concurrently accepted with different content",
        );
      }
      throw error;
    }
    return { id, offerId, acceptanceHash, acceptanceJson, status: "reserved" };
  }

  claimFundingSubmission(
    id: string,
    token: string,
    now: string,
    staleBefore: string,
  ): boolean {
    return this.database.prepare(`
      UPDATE lender_fundings
      SET status = 'preparing', submission_token = ?, updated_at = ?
      WHERE id = ? AND transaction_id IS NULL
        AND (status = 'reserved' OR (status = 'preparing' AND updated_at <= ?))
    `).run(token, now, id, staleBefore).changes === 1;
  }

  releaseFundingSubmission(id: string, token: string, now: string): void {
    this.database.prepare(`
      UPDATE lender_fundings
      SET status = 'reserved', submission_token = NULL, updated_at = ?
      WHERE id = ? AND status = 'preparing' AND transaction_id IS NULL
        AND submission_token = ?
    `).run(now, id, token);
  }

  setFundingTransaction(id: string, token: string, transactionId: string, now: string): void {
    const result = this.database.prepare(`
      UPDATE lender_fundings
      SET transaction_id = ?, status = 'pending', updated_at = ?
      WHERE id = ? AND status IN ('preparing', 'pending')
        AND submission_token = ?
        AND (transaction_id IS NULL OR transaction_id = ?)
    `).run(transactionId, now, id, token, transactionId);
    if (result.changes !== 1) {
      throw new CreditProtocolError(
        ErrorCode.FUNDING_MISMATCH,
        "Funding operation already has another transaction",
      );
    }
  }

  markFundingConfirmed(id: string, transactionId: string, now: string): void {
    const result = this.database.prepare(`
      UPDATE lender_fundings
      SET status = 'confirmed', updated_at = ?
      WHERE id = ? AND transaction_id = ? AND status IN ('pending', 'confirmed')
    `).run(now, id, transactionId);
    if (result.changes !== 1) {
      throw new CreditProtocolError(ErrorCode.FUNDING_MISMATCH, "Funding confirmation mismatch");
    }
  }

  enqueueRegistration(id: string, payload: unknown): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO lender_registration_outbox (funding_id, payload_json)
      VALUES (?, ?)
    `).run(id, JSON.stringify(payload));
  }

  pendingRegistration(id: string): unknown | undefined {
    const row = this.database.prepare(`
      SELECT payload_json FROM lender_registration_outbox
      WHERE funding_id = ? AND delivered_at IS NULL
    `).get(id) as { payload_json: string } | undefined;
    return row === undefined ? undefined : JSON.parse(row.payload_json);
  }

  recordRegistrationFailure(id: string, error: unknown): void {
    this.database.prepare(`
      UPDATE lender_registration_outbox
      SET attempts = attempts + 1, last_error = ?
      WHERE funding_id = ? AND delivered_at IS NULL
    `).run(error instanceof Error ? error.message : "Registration failed", id);
  }

  markRegistered(id: string, now: string): void {
    const complete = this.database.transaction(() => {
      this.database.prepare(`
        UPDATE lender_registration_outbox
        SET attempts = attempts + 1, delivered_at = ?, last_error = NULL
        WHERE funding_id = ? AND delivered_at IS NULL
      `).run(now, id);
      this.database.prepare(`
        UPDATE lender_fundings SET status = 'registered', updated_at = ? WHERE id = ?
      `).run(now, id);
    });
    complete.immediate();
  }

  getFundingByOffer(offerId: string): FundingRecord | undefined {
    const row = this.database.prepare(`
      SELECT id, offer_id, acceptance_hash, acceptance_json, transaction_id, status
      FROM lender_fundings WHERE offer_id = ?
    `).get(offerId) as {
      id: string;
      offer_id: string;
      acceptance_hash: string;
      acceptance_json: string;
      transaction_id: string | null;
      status: FundingRecord["status"];
    } | undefined;
    if (row === undefined) return undefined;
    return {
      id: row.id,
      offerId: row.offer_id,
      acceptanceHash: row.acceptance_hash,
      acceptanceJson: row.acceptance_json,
      status: row.status,
      ...(row.transaction_id === null ? {} : { transactionId: row.transaction_id }),
    };
  }
}
