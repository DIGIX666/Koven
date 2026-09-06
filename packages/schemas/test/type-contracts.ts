/** Compile-time bidirectional compatibility between domain types and JSON schemas.
 * Optional undefined is normalized because JSON omits it and Zod models it explicitly. */
import type { z } from "zod";
import type * as d from "@koven/domain";
import type * as a from "@koven/audit";
import type * as s from "../src/index.js";

type Wire<T> = T extends bigint ? string : T extends object
  ? { [K in keyof T]: Wire<T[K]> } : T;
type Normalize<T> = T extends object
  ? { [K in keyof T]: Normalize<Exclude<T[K], undefined>> } : T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Matches<S extends z.ZodTypeAny, D> = Equal<Normalize<z.infer<S>>, Normalize<Wire<D>>>;

export type ContractConformance = [
  Assert<Matches<typeof s.MissionSchema, d.Mission>>,
  Assert<Matches<typeof s.ProviderSchema, d.Provider>>,
  Assert<Matches<typeof s.RankedProviderSchema, d.RankedProvider>>,
  Assert<Matches<typeof s.CreditRequestSchema, d.CreditRequest>>,
  Assert<Matches<typeof s.UnsignedCreditRequestSchema, d.UnsignedCreditRequest>>,
  Assert<Matches<typeof s.CreditOfferSchema, d.CreditOffer>>,
  Assert<Matches<typeof s.CreditAcceptanceSchema, d.CreditAcceptance>>,
  Assert<Matches<typeof s.LoanSchema, d.Loan>>,
  Assert<Matches<typeof s.ScanRequestSchema, d.ScanRequest>>,
  Assert<Matches<typeof s.PaidScanRequestSchema, d.PaidScanRequest>>,
  Assert<Matches<typeof s.FindingSchema, d.Finding>>,
  Assert<Matches<typeof s.ScanReportSchema, d.ScanReport>>,
  Assert<Matches<typeof s.NormalizedChallengeSchema, d.NormalizedChallenge>>,
  Assert<Matches<typeof s.ProofBundleSchema, d.ProofBundle>>,
  Assert<Matches<typeof s.PaymentRequirementsSchema, d.PaymentRequirements>>,
  Assert<Matches<typeof s.ScanPaymentAuthorizationSchema, d.ScanPaymentAuthorization>>,
  Assert<Matches<typeof s.PaymentReceiptSchema, d.PaymentReceipt>>,
  Assert<Matches<typeof s.MissionOutcomeSchema, d.MissionOutcome>>,
  Assert<Matches<typeof s.AuditEventSchema, a.AuditEvent>>,
  Assert<Matches<typeof s.HcsEventEnvelopeSchema, a.HcsEventEnvelope>>,
  Assert<Matches<typeof s.ErrorResponseSchema, d.ErrorResponse>>,
];
