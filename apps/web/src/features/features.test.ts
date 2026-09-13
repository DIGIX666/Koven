import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { providerRankingFixture } from "../test-fixtures";
import { AuditWorkspace } from "./audit/audit-workspace";
import { CreditWorkspace } from "./credit/credit-workspace";
import { PaymentEvidencePanel, PaymentWorkspace } from "./payments/payment-workspace";
import { ProviderRanking } from "./providers/provider-ranking";

describe("future milestone integration states", () => {
  it("renders an explicit F11 credit empty state", () => {
    const html = renderToStaticMarkup(createElement(CreditWorkspace));
    expect(html).toContain("F11");
    expect(html).toContain("Waiting for competing offers");
  });

  it("renders an explicit F12 audit empty state", () => {
    const html = renderToStaticMarkup(createElement(AuditWorkspace));
    expect(html).toContain("F12");
    expect(html).toContain("HCS evidence is not published yet");
  });

  it("renders complete lender terms and the selected-offer explanation", () => {
    const html = renderToStaticMarkup(createElement(CreditWorkspace, { offers: [{
      id: "offer-1",
      lenderAccountId: "0.0.700",
      principalTinybar: "300000000",
      feeTinybar: "6000000",
      termSeconds: 600,
      expiresAt: "2026-09-13T11:00:00.000Z",
      score: 0.91,
      selected: true,
      breakdown: { cost: 0.95, headroom: 0.8, expiry: 0.7 },
    }] }));
    expect(html).toContain("Selected");
    expect(html).toContain("3.06 ℏ");
    expect(html).toContain("600s");
    expect(html).toContain("cost");
  });

  it("renders provider score details from the validated F11 contract", () => {
    const html = renderToStaticMarkup(createElement(ProviderRanking, { initialData: providerRankingFixture }));
    expect(html).toContain("provider-a");
    expect(html).toContain("Selected");
    expect(html).toContain("0.820");
    expect(html).toContain(providerRankingFixture.formula);
  });

  it("renders an explicit payment empty state until a mission is selected", () => {
    const html = renderToStaticMarkup(createElement(PaymentWorkspace));
    expect(html).toContain("Select a mission with payment evidence");
  });

  it("renders settled payment evidence with the HashScan link and the pinned key, without raw signing material", () => {
    const html = renderToStaticMarkup(createElement(PaymentEvidencePanel, { evidence: {
      missionId: "mission-demo-1",
      status: "settled",
      proof: "verified",
      circuitId: "koven-policy-v1",
      vkeyHash: "a".repeat(64),
      capTinybar: "2500000000",
      approvedRecipientsRoot: "123456789",
      targetSha256: "b".repeat(64),
      transactionId: "0.0.123@1789000000.123456789",
      authorizedAt: "2026-09-13T10:01:00.000Z",
      settledAt: "2026-09-13T10:02:00.000Z",
      proofGeneratedAt: "2026-09-13T10:00:30.000Z",
    } }));
    expect(html).toContain("Settled");
    expect(html).toContain("Verified");
    expect(html).toContain("https://hashscan.io/testnet/transaction/0.0.123%401789000000.123456789");
    expect(html).toContain(`title="${"a".repeat(64)}"`);
    expect(html).toContain("25 ℏ");
    expect(html).toContain("Hidden by design");
    expect(html).not.toContain("privateKey");
    expect(html).not.toContain("signedBytes");
  });

  it("distinguishes rejected and deterministic payments", () => {
    const base = {
      missionId: "mission-demo-1", circuitId: "koven-policy-v1", capTinybar: "1", approvedRecipientsRoot: "1", targetSha256: "b".repeat(64),
    };
    const rejected = renderToStaticMarkup(createElement(PaymentEvidencePanel, { evidence: {
      ...base, status: "rejected", proof: "rejected", vkeyHash: "a".repeat(64), rejectedAt: "2026-09-13T10:00:00.000Z",
    } }));
    expect(rejected).toContain("Rejected by policy");
    expect(rejected).toContain("Payment refused");
    expect(rejected).not.toContain("hashscan.io");
    const deterministic = renderToStaticMarkup(createElement(PaymentEvidencePanel, { evidence: {
      ...base, status: "pending", proof: "deterministic", vkeyHash: null,
    } }));
    expect(deterministic).toContain("Deterministic gate");
    expect(deterministic).toContain("No key pinned");
  });

  it("renders HCS sequence and public evidence without a local payload", () => {
    const html = renderToStaticMarkup(createElement(AuditWorkspace, { events: [{
      eventId: "event-1",
      sequenceNumber: "42",
      payloadHash: "b".repeat(64),
      transactionId: "0.0.123@1789000000.123456789",
      publishedAt: "2026-09-13T10:00:00.000Z",
    }] }));
    expect(html).toContain("Consensus #42");
    expect(html).toContain("Public evidence");
    expect(html).not.toContain("payload_json");
  });
});
