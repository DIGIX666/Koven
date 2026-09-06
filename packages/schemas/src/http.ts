import { z } from "zod";
import { AccountId, Base64, FieldElement, Id, Nonce, Sha256, Signature, Source, TargetRef, TinybarString, TransactionId } from "./common.js";
import { AuditEventSchema, CreditAcceptanceSchema, CreditOfferSchema, CreditRequestSchema, ErrorResponseSchema, MissionOutcomeSchema, MissionSchema, NormalizedChallengeSchema, PaymentRequirementsSchema, ProofBundleSchema, ProviderSchema, RankedProviderSchema, ScanReportSchema, ScanRequestSchema, UnsignedCreditRequestSchema } from "./domain.js";

export const AuthorizeRequestSchema = z.object({ missionId: Id, requirements: PaymentRequirementsSchema, nonce: Nonce, bundle: ProofBundleSchema.optional() }).strict();
export const AuthorizeZkRequestSchema = AuthorizeRequestSchema.required({ bundle: true });
export const AuthorizeResponseSchema = z.object({ transaction: Base64 }).strict();
export const RepayRequestSchema = z.object({ missionId: Id, loanId: Id, idempotencyKey: z.string() }).strict()
  .refine(v => v.idempotencyKey === `repayment:${v.loanId}`, "Invalid repayment key");
export const RepayResponseSchema = z.object({ transactionId: TransactionId }).strict();
export const SignCreditRequestSchema = z.object({ request: UnsignedCreditRequestSchema }).strict();
export const SignatureResponseSchema = z.object({ signature: Signature }).strict();
const PaymentEvidence = { paymentIntent: NormalizedChallengeSchema.optional(), paymentProofBundle: ProofBundleSchema.optional() };
const evidencePaired = (v: { paymentIntent?: unknown; paymentProofBundle?: unknown }) => (v.paymentIntent === undefined) === (v.paymentProofBundle === undefined);
export const SignCreditAcceptanceSchema = z.object({ offer: CreditOfferSchema, ...PaymentEvidence }).strict().refine(evidencePaired, "Intent and proof must be present together");
export const SignCreditAcceptanceZkSchema = z.object({ offer: CreditOfferSchema, paymentIntent: NormalizedChallengeSchema, paymentProofBundle: ProofBundleSchema }).strict();
export const SignedAcceptanceSchema = z.object({ acceptance: CreditAcceptanceSchema, signature: Signature }).strict();
export const CreditAcceptRequestSchema = z.object({ acceptance: CreditAcceptanceSchema, signature: Signature, ...PaymentEvidence }).strict()
  .refine(evidencePaired, "Intent and proof must be present together")
  .refine(v => (v.paymentIntent !== undefined) === (v.acceptance.paymentIntentHash !== undefined), "Acceptance must bind supplied evidence");
export const CreditAcceptZkRequestSchema = z.object({ acceptance: CreditAcceptanceSchema, signature: Signature, paymentIntent: NormalizedChallengeSchema, paymentProofBundle: ProofBundleSchema }).strict()
  .refine(v => v.acceptance.paymentIntentHash !== undefined, "M3 requires signed evidence hashes");
export const CreditAcceptResponseSchema = z.object({ fundingTxId: TransactionId }).strict();
export const LoanRegistrationRequestSchema = z.object({
  loanId: Id, request: CreditRequestSchema, offer: CreditOfferSchema, acceptance: CreditAcceptanceSchema,
  signatures: z.object({ acceptance: Signature }).strict(), fundingTxId: TransactionId,
}).strict();
export const LoanRegistrationResponseSchema = z.object({ loanId: Id, state: z.literal("funded") }).strict();
export const HealthResponseSchema = z.object({ status: z.literal("ok"), circuitId: Id, vkeyHash: Sha256.nullable() }).strict();
export const ProvidersResponseSchema = z.array(ProviderSchema);
export const ProviderRankQuerySchema = z.object({ capability: Id, maxPriceTinybar: TinybarString }).strict();
export const ProviderRankResponseSchema = z.object({ ranked: z.array(RankedProviderSchema), formula: z.string().min(1).max(2048) }).strict();
export const CreateMissionRequestSchema = z.object({ prompt: z.string().min(1).max(8192), maxBudgetTinybar: TinybarString, targetRef: TargetRef, source: Source }).strict();
export const MissionParamsSchema = z.object({ id: Id }).strict();
export const MissionDetailResponseSchema = MissionSchema.extend({ events: z.array(AuditEventSchema) });
export const CompletionCallbackSchema = z.object({ outcome: MissionOutcomeSchema, report: ScanReportSchema }).strict().superRefine((v, ctx) => {
  if (!v.outcome.delivered || v.outcome.missionId !== v.report.missionId || v.outcome.reportSha256 !== v.report.reportSha256)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Callback must describe the delivered report" });
});
export const CallbackHeadersSchema = z.object({
  "idempotency-key": z.string().regex(/^mission-complete:[A-Za-z0-9][A-Za-z0-9._-]*:[0-9a-f]{64}$/),
  "x-callback-timestamp": z.string().regex(/^(0|[1-9]\d{0,11})$/),
  "x-callback-signature": Sha256,
}).strict();
export const CallbackResponseSchema = z.union([
  z.object({ status: z.literal("accepted") }).strict(),
  z.object({ status: z.literal("duplicate"), code: z.literal("callback_duplicate") }).strict(),
]);
// Selected headers only: adapters extract these before schema validation.
export const ServiceAuthHeadersSchema = z.object({ authorization: z.string().regex(/^Bearer [A-Za-z0-9_-]{43,}$/) }).strict();
export const MissionPolicyRequestSchema = z.object({
  missionId: Id, borrowerAccountId: AccountId, spendingCapTinybar: TinybarString,
  sessionId: Id, sessionCapTinybar: TinybarString, targetSha256: Sha256,
  provider: ProviderSchema, approvedRecipientsRoot: FieldElement,
}).strict();
export const MissionPolicyResponseSchema = z.object({ missionId: Id, status: z.literal("registered") }).strict();
export const NoBodySchema = z.undefined();
export const PaymentRequiredHeadersSchema = z.object({ "payment-required": Base64 }).strict();
export const PaymentResponseHeadersSchema = z.object({ "payment-response": Base64 }).strict();

/** Every JSON body and empty response in the frozen MVP surface. x402 headers
 * remain SDK-encoded envelopes; this package validates the header transport. */
export const HTTP_CONTRACTS = {
  authorize: { request: AuthorizeRequestSchema, response: AuthorizeResponseSchema },
  repay: { request: RepayRequestSchema, response: RepayResponseSchema },
  signCreditRequest: { request: SignCreditRequestSchema, response: SignatureResponseSchema },
  signCreditAcceptance: { request: SignCreditAcceptanceSchema, response: SignedAcceptanceSchema },
  registerLoan: { request: LoanRegistrationRequestSchema, response: LoanRegistrationResponseSchema },
  registerMissionPolicy: { request: MissionPolicyRequestSchema, response: MissionPolicyResponseSchema },
  signerCompletion: { request: CompletionCallbackSchema, response: CallbackResponseSchema },
  health: { request: NoBodySchema, response: HealthResponseSchema },
  providers: { request: NoBodySchema, response: ProvidersResponseSchema },
  rankProviders: { request: ProviderRankQuerySchema, response: ProviderRankResponseSchema },
  scan: { request: ScanRequestSchema, response: ScanReportSchema },
  scanChallenge: { request: ScanRequestSchema, response: NoBodySchema },
  createMission: { request: CreateMissionRequestSchema, response: MissionSchema },
  missionDetail: { request: MissionParamsSchema, response: MissionDetailResponseSchema },
  completion: { request: CompletionCallbackSchema, response: CallbackResponseSchema },
  quote: { request: CreditRequestSchema, response: CreditOfferSchema },
  quoteDeclined: { request: CreditRequestSchema, response: NoBodySchema },
  accept: { request: CreditAcceptRequestSchema, response: CreditAcceptResponseSchema },
  error: { request: NoBodySchema, response: ErrorResponseSchema },
} as const;
export type HttpContractName = keyof typeof HTTP_CONTRACTS;
export type HttpRequest<K extends HttpContractName> = z.infer<(typeof HTTP_CONTRACTS)[K]["request"]>;
export type HttpResponse<K extends HttpContractName> = z.infer<(typeof HTTP_CONTRACTS)[K]["response"]>;
