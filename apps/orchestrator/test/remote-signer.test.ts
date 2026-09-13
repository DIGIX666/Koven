import { ErrorCode } from "@koven/domain";
import { describe, expect, it, vi } from "vitest";

import {
  HttpMissionPolicyRegistrar,
  HttpRepaymentClient,
  HttpSignerCompletionClient,
} from "../src/index.js";

const rawCallback = Buffer.from('{"outcome":"preserve these exact bytes"}\n', "utf8");
const callbackHeaders = {
  idempotencyKey: `mission-complete:mission-1:${"a".repeat(64)}`,
  timestamp: "1789293600",
  signature: "b".repeat(64),
};
const missionPolicy = {
  missionId: "mission-1",
  borrowerAccountId: "0.0.1001",
  spendingCapTinybar: "1000",
  sessionId: "session-1",
  sessionCapTinybar: "1000",
  targetSha256: "c".repeat(64),
  provider: {
    id: "provider-a",
    accountId: "0.0.3001",
    endpoint: "https://provider.example",
    capability: "solidity-scan",
    priceTinybar: "100",
    reputationScore: 0.9,
    expectedLatencyMs: 50,
  },
  approvedRecipientsRoot: "1",
};

describe("orchestrator restricted-signer clients", () => {
  it("forwards exact callback bytes and provider authentication headers", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new URL(input instanceof Request ? input.url : input).pathname).toBe("/internal/missions/complete");
      expect(init?.method).toBe("POST");
      expect(init?.body).toEqual(rawCallback);
      const headers = new Headers(init?.headers);
      expect(headers.get("idempotency-key")).toBe(callbackHeaders.idempotencyKey);
      expect(headers.get("x-callback-timestamp")).toBe(callbackHeaders.timestamp);
      expect(headers.get("x-callback-signature")).toBe(callbackHeaders.signature);
      expect(headers.get("authorization")).toBeNull();
      return new Response(JSON.stringify({ status: "accepted" }), { status: 202 });
    });
    const client = new HttpSignerCompletionClient({
      baseUrl: "https://signer.example",
      fetch: fetchMock,
    });

    await expect(client.complete({ body: rawCallback, headers: callbackHeaders }))
      .resolves.toEqual({ status: "accepted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a signer-observed settlement mismatch to a permanent callback rejection", async () => {
    const client = new HttpSignerCompletionClient({
      baseUrl: "https://signer.example",
      fetch: vi.fn(async () => new Response(JSON.stringify({
        code: ErrorCode.FUNDING_MISMATCH,
        detail: "Settlement recipient differs",
      }), { status: 409 })),
    });

    await expect(client.complete({ body: rawCallback, headers: callbackHeaders })).rejects.toMatchObject({
      code: ErrorCode.REPORT_BINDING_MISMATCH,
      status: 400,
      message: "Settlement recipient differs",
    });
  });

  it("sends only trusted repayment identifiers with the orchestrator credential", async () => {
    const credential = "r".repeat(43);
    const request = {
      missionId: "mission-1",
      loanId: "loan-1",
      idempotencyKey: "repayment:loan-1",
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new URL(input instanceof Request ? input.url : input).pathname).toBe("/repay");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${credential}`);
      expect(JSON.parse(String(init?.body))).toEqual(request);
      expect(Object.keys(JSON.parse(String(init?.body))).sort()).toEqual([
        "idempotencyKey",
        "loanId",
        "missionId",
      ]);
      return new Response(JSON.stringify({
        transactionId: "0.0.1001@1789293600.000000001",
      }), { status: 200 });
    });
    const client = new HttpRepaymentClient({
      baseUrl: "https://signer.example",
      credential,
      fetch: fetchMock,
    });

    await expect(client.repay(request)).resolves.toEqual({
      transactionId: "0.0.1001@1789293600.000000001",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("registers the exact mission policy through an authenticated service boundary", async () => {
    const credential = "p".repeat(43);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new URL(input instanceof Request ? input.url : input).pathname).toBe("/internal/missions/register");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${credential}`);
      expect(JSON.parse(String(init?.body))).toEqual(missionPolicy);
      return new Response(JSON.stringify({
        status: "registered",
        missionId: missionPolicy.missionId,
      }), { status: 200 });
    });
    const registrar = new HttpMissionPolicyRegistrar({
      baseUrl: "https://signer.example",
      credential,
      fetch: fetchMock,
    });

    await expect(registrar.register(missionPolicy)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unavailable or mismatched mission-policy acknowledgements", async () => {
    const credential = "p".repeat(43);
    const unavailable = new HttpMissionPolicyRegistrar({
      baseUrl: "https://signer.example",
      credential,
      fetch: vi.fn(async () => { throw new Error("offline"); }),
    });
    await expect(unavailable.register(missionPolicy)).rejects.toMatchObject({
      status: 503,
      code: ErrorCode.SETTLEMENT_UNCONFIRMED,
    });

    const mismatched = new HttpMissionPolicyRegistrar({
      baseUrl: "https://signer.example",
      credential,
      fetch: vi.fn(async () => new Response(JSON.stringify({
        status: "registered",
        missionId: "mission-2",
      }), { status: 200 })),
    });
    await expect(mismatched.register(missionPolicy)).rejects.toMatchObject({ status: 502 });
  });

  it("rejects non-loopback cleartext signer origins", () => {
    expect(() => new HttpSignerCompletionClient({ baseUrl: "http://signer.example" })).toThrow(/HTTPS/);
    expect(() => new HttpRepaymentClient({
      baseUrl: "http://signer.example",
      credential: "r".repeat(43),
    })).toThrow(/HTTPS/);
    expect(() => new HttpMissionPolicyRegistrar({
      baseUrl: "http://signer.example",
      credential: "p".repeat(43),
    })).toThrow(/HTTPS/);
  });
});
