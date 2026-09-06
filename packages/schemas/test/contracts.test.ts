import { test } from "node:test";
import assert from "node:assert/strict";
import * as s from "../src/index.js";
import { acceptance, bundle, callback, event, fixtures, hash, intent, offer, signature, time, tx } from "./fixtures.js";

for (const [name, contract] of Object.entries(s.HTTP_CONTRACTS)) {
  test(`${name}: accepts frozen request and response fixtures`, () => {
    const fixture = fixtures[name as s.HttpContractName];
    const roundTrip = (v: unknown) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
    contract.request.parse(roundTrip(fixture.request));
    contract.response.parse(roundTrip(fixture.response));
  });
}
test("money preserves uint64 precision and rejects ambiguous or overflowing encodings", () => {
  const largest = "18446744073709551615";
  assert.equal(s.fromTinybar(s.toTinybar(largest)), largest);
  for (const v of ["01", "-1", "1.5", "1e3", "18446744073709551616", "NaN", 1, 1n])
    assert.equal(s.TinybarString.safeParse(v).success, false);
  assert.throws(() => s.fromTinybar(-1n));
});
test("nonce, account and field validation fail without throwing on hostile strings", () => {
  for (const schema of [s.Nonce, s.FieldElement, s.CurveCoordinate, s.AccountId])
    for (const v of ["nope", "-1", "", "1e9", "00"])
      assert.equal(schema.safeParse(v).success, false);
  assert.equal(s.Nonce.safeParse((1n << 248n).toString()).success, false);
  assert.equal(s.FieldElement.safeParse(s.SCALAR_FIELD.toString()).success, false);
});
test("source limit counts UTF-8 bytes rather than characters", () => {
  s.Source.parse("é".repeat(s.MAX_SOURCE_BYTES / 2));
  assert.equal(s.Source.safeParse("é".repeat(s.MAX_SOURCE_BYTES / 2 + 1)).success, false);
});
test("commands reject destination injection, unknown fields and arbitrary signing", () => {
  assert.equal(s.RepayRequestSchema.safeParse({ ...fixtures.repay.request, recipient: "0.0.999" }).success, false);
  assert.equal(s.RepayRequestSchema.safeParse({ ...fixtures.repay.request, idempotencyKey: "repayment:other" }).success, false);
  assert.equal(s.SignCreditRequestSchema.safeParse({ bytes: "AQID" }).success, false);
  assert.equal(s.SignCreditRequestSchema.safeParse({ request: { ...fixtures.signCreditRequest.request.request, signature } }).success, false);
  assert.equal(s.PaymentRequirementsSchema.safeParse({ ...fixtures.authorize.request.requirements, asset: "HBAR" }).success, false);
});
test("M3 requires proofs and paired signed evidence", () => {
  assert.equal(s.AuthorizeZkRequestSchema.safeParse(fixtures.authorize.request).success, false);
  s.AuthorizeZkRequestSchema.parse({ ...fixtures.authorize.request, bundle });
  assert.equal(s.SignCreditAcceptanceSchema.safeParse({ offer, paymentIntent: intent }).success, false);
  assert.equal(s.CreditAcceptZkRequestSchema.safeParse(fixtures.accept.request).success, false);
  const signed = { ...acceptance, paymentIntentHash: hash, paymentProofBundleHash: hash };
  s.SignCreditAcceptanceZkSchema.parse({ offer, paymentIntent: intent, paymentProofBundle: bundle });
  s.CreditAcceptZkRequestSchema.parse({ acceptance: signed, signature, paymentIntent: intent, paymentProofBundle: bundle });
  assert.equal(s.CreditAcceptRequestSchema.safeParse({ acceptance: signed, signature }).success, false);
  assert.equal(s.ProofBundleSchema.safeParse({ ...bundle, publicSignals: ["1", "2"] }).success, false);
  assert.equal(s.ProofBundleSchema.safeParse({ ...bundle, proof: {} }).success, false);
});
test("completion rejects missing evidence and cross-report envelopes", () => {
  assert.equal(s.CompletionCallbackSchema.safeParse({ ...callback, outcome: { ...callback.outcome, missionId: "other" } }).success, false);
  assert.equal(s.MissionOutcomeSchema.safeParse({ missionId: "m1", delivered: true, observedAt: time }).success, false);
  s.MissionOutcomeSchema.parse({ missionId: "m1", delivered: false, failureReason: "timeout", observedAt: time });
  assert.equal(s.ScanReportSchema.safeParse({ ...callback.report, completedAt: "2020-01-01T00:00:00Z" }).success, false);
});
test("headers, duplicates, audit envelopes, loans and receipts have explicit schemas", () => {
  s.CallbackHeadersSchema.parse({ "idempotency-key": `mission-complete:mission-1:${hash}`, "x-callback-timestamp": "1788696000", "x-callback-signature": hash });
  s.CallbackResponseSchema.parse({ status: "duplicate", code: "callback_duplicate" });
  s.ServiceAuthHeadersSchema.parse({ authorization: `Bearer ${"a".repeat(43)}` });
  s.PaymentRequiredHeadersSchema.parse({ "payment-required": "AQID" });
  s.PaymentResponseHeadersSchema.parse({ "payment-response": "AQID" });
  const { id, ...publicEvent } = event;
  s.HcsEventEnvelopeSchema.parse({ ...publicEvent, v: 1, eventId: id });
  assert.equal(s.AuditEventSchema.safeParse({ ...event, signature }).success, false);
  s.LoanSchema.parse({ id: "loan-1", offerId: offer.id, missionId: "mission-1", lenderAccountId: offer.lenderAccountId, principalTinybar: "100", feeTinybar: "1", state: "funded", fundingTxId: tx });
  s.PaymentReceiptSchema.parse({ missionId: "mission-1", transactionId: tx, network: "hedera:testnet", payer: "0.0.10", recipientAccountId: "0.0.20", asset: "0.0.0", amountTinybar: "100", settledAt: time });
});

test("paid scans require complete authorization and matching mission/source claims", () => {
  assert.equal(s.PaidScanRequestSchema.safeParse(fixtures.scanChallenge.request).success, false);
  assert.equal(s.AuthorizeResponseSchema.safeParse({ transaction: "AQID" }).success, false);
  for (const change of [{ missionId: "other" }, { targetSha256: "c".repeat(64) }])
    assert.equal(s.PaidScanRequestSchema.safeParse({ ...fixtures.scan.request, ...change }).success, false);
  const { signature: omitted, ...unsigned } = fixtures.scan.request.paymentAuthorization;
  assert.equal(s.PaidScanRequestSchema.safeParse({ ...fixtures.scan.request, paymentAuthorization: unsigned }).success, false);
});
