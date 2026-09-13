import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { providerRankingFixture } from "../test-fixtures";
import { AuditWorkspace } from "./audit/audit-workspace";
import { CreditWorkspace } from "./credit/credit-workspace";
import { PaymentWorkspace } from "./payments/payment-workspace";
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

  it("renders payment evidence without raw signing material", () => {
    const html = renderToStaticMarkup(createElement(PaymentWorkspace, { evidence: {
      transactionId: "0.0.123@1789000000.123456789",
      amountTinybar: "1000000",
      recipient: "0.0.456",
      circuitId: "koven-policy-v1",
      vkeyHash: "a".repeat(64),
      verified: true,
    } }));
    expect(html).toContain("Verified");
    expect(html).toContain("HashScan");
    expect(html).toContain("Hidden by design");
    expect(html).not.toContain("privateKey");
    expect(html).not.toContain("signedBytes");
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
