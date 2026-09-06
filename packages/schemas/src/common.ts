import { z } from "zod";

export const MAX_SOURCE_BYTES = 262_144;
export const MAX_HTTP_BODY_BYTES = 2_097_152;
export const CALLBACK_CLOCK_SKEW_SECONDS = 300;
export const UINT64_MAX = (1n << 64n) - 1n;
export const SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const Decimal = z.string().regex(/^(0|[1-9]\d*)$/);
export const TinybarString = Decimal.max(20).refine(v => /^(0|[1-9]\d*)$/.test(v) && v.length <= 20 && BigInt(v) <= UINT64_MAX, "Amount exceeds uint64");
export const toTinybar = (value: string): bigint => BigInt(TinybarString.parse(value));
export const fromTinybar = (value: bigint): string => TinybarString.parse(value.toString());
export const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const AccountId = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  .max(62).refine(v => v.split(".").every(n => /^(0|[1-9]\d*)$/.test(n) && n.length <= 20 && BigInt(n) <= UINT64_MAX));
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const Timestamp = z.string().datetime();
export const Nonce = Decimal.max(75).refine(v => /^(0|[1-9]\d*)$/.test(v) && v.length <= 75 && BigInt(v) < (1n << 248n), "Nonce exceeds 248 bits");
export const FieldElement = Decimal.max(77).refine(v => /^(0|[1-9]\d*)$/.test(v) && v.length <= 77 && BigInt(v) < SCALAR_FIELD, "Invalid scalar field element");
// Base-field coordinates use a different modulus from public scalar signals.
export const CurveCoordinate = Decimal.max(77).refine(v => /^(0|[1-9]\d*)$/.test(v) && v.length <= 77 && BigInt(v) < 21888242871839275222246405745257275088696311157297823662689037894645226208583n);
export const Signature = z.string().regex(/^[0-9a-f]{128}$/); // 64-byte ECDSA r || s
export const TransactionId = z.string().max(100).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)@(0|[1-9]\d*)\.\d{9}$/);
export const Source = z.string().min(1).refine(v => new TextEncoder().encode(v).length <= MAX_SOURCE_BYTES, "Source exceeds 256 KiB");
export const TargetRef = z.string().min(1).max(512);
export const HttpUrl = z.string().url().refine(v => /^https?:\/\//.test(v));
export const PositiveSeconds = z.number().int().positive().max(2_147_483_647);
export const Base64 = z.string().min(4).max(MAX_HTTP_BODY_BYTES).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
