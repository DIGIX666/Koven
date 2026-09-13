import { createHash, timingSafeEqual } from "node:crypto";

import express, { type Application, type ErrorRequestHandler, type RequestHandler } from "express";
import { ErrorCode } from "@koven/domain";
import type { KovenDatabase } from "@koven/persistence";
import { rankProviders } from "@koven/policy";
import { AccountId, CreateMissionRequestSchema, Id, MissionPolicyRequestSchema, type HttpRequest } from "@koven/schemas";
import { loadPoseidon } from "@koven/x402";
import { buildMissionRecipientRoot } from "@koven/zk-policy";
import { z, ZodError } from "zod";

import type { ProviderRegistry } from "./registry.js";
import { getProviderReputations } from "./reputation.js";
import { DIRECTORY_RANKING_FORMULA } from "./server.js";

const ApprovalSchema = z.object({ missionId: Id, request: CreateMissionRequestSchema }).strict();
const encode = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item);
const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

export interface RegistrarOptions {
  /** Private database, never writable by the orchestrator. */
  readonly database: KovenDatabase;
  readonly eventDatabase: KovenDatabase;
  readonly registry: ProviderRegistry;
  readonly borrowerAccountId: string;
  readonly operatorCredential: string;
  readonly orchestratorCredential: string;
  readonly targets: readonly { register(policy: HttpRequest<"registerMissionPolicy">): Promise<void> }[];
}

/** Operator approval freezes metadata, event-derived reputation and the complete policy.
 * Provisioning accepts only that exact proposal and sends the stored policy to all targets.
 */
export async function createRegistrarApp(options: RegistrarOptions): Promise<Application> {
  AccountId.parse(options.borrowerAccountId);
  if (options.targets.length === 0) throw new Error("Registrar requires policy targets");
  const credentials = [options.operatorCredential, options.orchestratorCredential];
  if (credentials.some(value => !/^[A-Za-z0-9_-]{43,}$/.test(value)) || new Set(credentials).size !== 2) {
    throw new Error("Registrar requires distinct operator and orchestrator credentials");
  }
  const poseidon = await loadPoseidon();
  options.database.exec(`CREATE TABLE IF NOT EXISTS registrar_approvals (
    mission_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, policy_json TEXT NOT NULL, ranking_json TEXT NOT NULL
  )`);
  const read = (id: string) => options.database.prepare(
    "SELECT request_json, policy_json, ranking_json FROM registrar_approvals WHERE mission_id = ?",
  ).get(id) as { request_json: string; policy_json: string; ranking_json: string } | undefined;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  const authenticate = (expected: string): RequestHandler => (request, response, next) => {
    if (!timingSafeEqual(digest(request.headers.authorization ?? ""), digest(`Bearer ${expected}`))) {
      response.status(401).json({ code: ErrorCode.AUTH_INVALID, detail: "Unauthorized registrar request" });
      return;
    }
    next();
  };
  app.post("/missions/approve", authenticate(options.operatorCredential), (request, response) => {
    const approval = ApprovalSchema.parse(request.body);
    const existing = read(approval.missionId);
    if (existing !== undefined) {
      if (existing.request_json !== encode(approval.request)) {
        response.status(409).json({ code: ErrorCode.MISSION_POLICY_CONFLICT, detail: "Mission approval is immutable" });
        return;
      }
      response.json({ missionId: approval.missionId });
      return;
    }
    const records = options.registry.list();
    const reputation = getProviderReputations(options.eventDatabase, records.map(record => record.id));
    const ranked = rankProviders(records.map(record => ({ ...record, reputationScore: reputation.get(record.id)!.score })), {
      capability: "solidity-scan", maxPriceTinybar: BigInt(approval.request.maxBudgetTinybar),
    });
    const provider = ranked[0]?.provider;
    if (!provider || provider.priceTinybar > BigInt(approval.request.maxBudgetTinybar)) {
      response.status(400).json({ code: ErrorCode.REQUEST_INVALID, detail: "No provider within the approved budget" });
      return;
    }
    const policy = MissionPolicyRequestSchema.parse({
      missionId: approval.missionId, borrowerAccountId: options.borrowerAccountId,
      spendingCapTinybar: approval.request.maxBudgetTinybar,
      sessionId: `session-${approval.missionId}`, sessionCapTinybar: approval.request.maxBudgetTinybar,
      targetSha256: createHash("sha256").update(approval.request.source).digest("hex"),
      provider: { ...provider, priceTinybar: provider.priceTinybar.toString() },
      approvedRecipientsRoot: buildMissionRecipientRoot(provider.accountId, poseidon),
    });
    options.database.prepare("INSERT INTO registrar_approvals VALUES (?, ?, ?, ?)").run(
      approval.missionId, encode(approval.request), encode(policy), encode({ ranked, formula: DIRECTORY_RANKING_FORMULA }),
    );
    response.json({ missionId: approval.missionId });
  });
  app.get("/providers/rank", authenticate(options.orchestratorCredential), (request, response) => {
    const approved = read(Id.parse(request.query.missionId));
    if (!approved) {
      response.status(404).json({ code: ErrorCode.REQUEST_INVALID, detail: "Mission has no operator approval" });
      return;
    }
    const policy = MissionPolicyRequestSchema.parse(JSON.parse(approved.policy_json));
    if (request.query.capability !== policy.provider.capability || request.query.maxPriceTinybar !== policy.spendingCapTinybar) {
      response.status(409).json({ code: ErrorCode.MISSION_POLICY_CONFLICT, detail: "Ranking differs from operator approval" });
      return;
    }
    response.json(JSON.parse(approved.ranking_json));
  });
  app.post("/missions/provision", authenticate(options.orchestratorCredential), async (request, response) => {
    const proposal = MissionPolicyRequestSchema.parse(request.body);
    const approved = read(proposal.missionId);
    if (!approved || encode(proposal) !== approved.policy_json) {
      response.status(409).json({ code: ErrorCode.MISSION_POLICY_CONFLICT, detail: "Proposal differs from operator approval" });
      return;
    }
    const policy = MissionPolicyRequestSchema.parse(JSON.parse(approved.policy_json));
    const results = await Promise.allSettled(options.targets.map(target => target.register(policy)));
    const failed = results.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
    response.json({ missionId: policy.missionId, status: "registered" });
  });
  const errors: ErrorRequestHandler = (error, _request, response, _next) => {
    const invalid = error instanceof ZodError;
    response.status(invalid ? 400 : 503).json({ code: invalid ? ErrorCode.REQUEST_INVALID : ErrorCode.INTERNAL_ERROR,
      detail: invalid ? "Invalid registrar request" : "Policy provisioning is incomplete; retry the same proposal" });
  };
  app.use(errors);
  return app;
}
