import { z } from "zod";
import { ErrorCode } from "@koven/domain";
import { AUDIT_EVENT_TYPES } from "@koven/audit";
import { AccountId, CurveCoordinate, FieldElement, HttpUrl, Id, Nonce, PositiveSeconds, Sha256, Signature, Source, TargetRef, Timestamp, TinybarString, TransactionId } from "./common.js";

export const MissionStateSchema = z.enum(["created", "discovering-services", "credit-requested", "funded", "payment-preparation", "payment-authorized", "service-paid", "running", "completed", "repayment-pending", "repaid", "policy-rejected", "recovery", "failed", "defaulted", "closed"]);
export const MissionSchema = z.object({
  id: Id, state: MissionStateSchema, spendingCapTinybar: TinybarString, spentTinybar: TinybarString,
  approvedRecipientsRoot: FieldElement, targetRef: TargetRef, targetSha256: Sha256,
  createdAt: Timestamp, updatedAt: Timestamp,
}).strict();
export const ProviderSchema = z.object({
  id: Id, accountId: AccountId, endpoint: HttpUrl.refine(v => {
    try { const u = new URL(v); return !u.search && !u.hash && !u.username && !u.password && !v.endsWith("/"); }
    catch { return false; }
  }, "Expected service base URL without trailing slash, credentials, query or fragment"), capability: Id,
  priceTinybar: TinybarString, reputationScore: z.number().finite().min(0).max(1),
  expectedLatencyMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export const RankedProviderSchema = z.object({
  provider: ProviderSchema, score: z.number().finite(),
  breakdown: z.object({ price: z.number().finite(), reputation: z.number().finite(), latency: z.number().finite() }).strict(),
}).strict();
export const UnsignedCreditRequestSchema = z.object({
  id: Id, missionId: Id, borrowerAccountId: AccountId, principalTinybar: TinybarString,
  requestedTermSeconds: PositiveSeconds, purposeHash: Sha256, createdAt: Timestamp,
}).strict();
export const CreditRequestSchema = UnsignedCreditRequestSchema.extend({ signature: Signature });
export const CreditOfferSchema = z.object({
  id: Id, requestId: Id, lenderAccountId: AccountId, principalTinybar: TinybarString,
  feeTinybar: TinybarString, termSeconds: PositiveSeconds, expiresAt: Timestamp,
  termsHash: Sha256, signature: Signature,
}).strict();
export const CreditAcceptanceSchema = z.object({
  requestId: Id, missionId: Id, borrowerAccountId: AccountId, lenderAccountId: AccountId,
  offerId: Id, termsHash: Sha256, expiresAt: Timestamp,
  paymentIntentHash: Sha256.optional(), paymentProofBundleHash: Sha256.optional(),
}).strict().refine(v => (v.paymentIntentHash === undefined) === (v.paymentProofBundleHash === undefined), "Both payment hashes must be present together");
export const LoanStateSchema = z.enum(["offered", "accepted", "funded", "repaid", "defaulted"]);
export const LoanSchema = z.object({
  id: Id, offerId: Id, missionId: Id, lenderAccountId: AccountId,
  principalTinybar: TinybarString, feeTinybar: TinybarString, state: LoanStateSchema,
  fundingTxId: TransactionId.optional(), repaymentTxId: TransactionId.optional(),
}).strict();
export const ScanRequestSchema = z.object({ missionId: Id, targetRef: TargetRef, source: Source, targetSha256: Sha256 }).strict();
export const SeveritySchema = z.enum(["info", "low", "medium", "high", "critical"]);
export const FindingSchema = z.object({
  ruleId: Id, severity: SeveritySchema, file: TargetRef, line: z.number().int().positive(), message: z.string().min(1).max(4096),
}).strict();
export const ScanReportSchema = z.object({
  schemaVersion: z.literal(1), missionId: Id, targetSha256: Sha256, providerId: Id,
  findings: z.array(FindingSchema).max(1000), startedAt: Timestamp, completedAt: Timestamp, reportSha256: Sha256,
}).strict().refine(v => Date.parse(v.completedAt) >= Date.parse(v.startedAt), "Completion precedes scan start");
export const NormalizedChallengeSchema = z.object({
  amountTinybar: TinybarString, recipientAccountId: AccountId, nonce: Nonce, resourceHash: Sha256, missionId: Id,
}).strict();
const Point = z.tuple([CurveCoordinate, CurveCoordinate, CurveCoordinate]);
const Pair = z.tuple([CurveCoordinate, CurveCoordinate]);
export const ProofBundleSchema = z.object({
  proof: z.object({ protocol: z.literal("groth16"), curve: z.literal("bn128"), pi_a: Point,
    pi_b: z.tuple([Pair, Pair, Pair]), pi_c: Point }).strict(),
  publicSignals: z.tuple([FieldElement, FieldElement, TinybarString]),
  vkeyHash: Sha256, circuitId: Id,
}).strict();
export const PaymentRequirementsSchema = z.object({
  scheme: z.literal("exact"), network: z.literal("hedera:testnet"), asset: z.literal("0.0.0"),
  amount: TinybarString, payTo: AccountId, maxTimeoutSeconds: PositiveSeconds,
  extra: z.object({ feePayer: AccountId }).strict(),
}).strict();
export const PaymentReceiptSchema = z.object({
  missionId: Id, transactionId: TransactionId, network: z.literal("hedera:testnet"),
  payer: AccountId, recipientAccountId: AccountId, asset: z.literal("0.0.0"), amountTinybar: TinybarString, settledAt: Timestamp,
}).strict();
export const MissionOutcomeSchema = z.object({
  missionId: Id, delivered: z.boolean(), reportSha256: Sha256.optional(), settlementTxId: TransactionId.optional(),
  failureReason: z.string().min(1).max(1024).optional(), observedAt: Timestamp,
}).strict().superRefine((v, ctx) => {
  if (v.delivered ? (!v.reportSha256 || !v.settlementTxId || v.failureReason !== undefined) : !v.failureReason)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Outcome must contain delivery evidence or failure reason" });
});
export const AuditEventTypeSchema = z.enum(AUDIT_EVENT_TYPES);
export const AuditEventSchema = z.object({
  id: Id, missionId: Id, type: AuditEventTypeSchema, payloadHash: Sha256,
  transactionId: TransactionId.optional(), occurredAt: Timestamp,
}).strict();
export const HcsEventEnvelopeSchema = AuditEventSchema.omit({ id: true }).extend({ v: z.literal(1), eventId: Id });
export const ErrorResponseSchema = z.object({ code: z.nativeEnum(ErrorCode), detail: z.string().min(1).max(1024) }).strict();
