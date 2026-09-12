import { timingSafeEqual } from "node:crypto";

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { ErrorCode } from "@koven/domain";
import { ErrorResponseSchema, HealthResponseSchema, MAX_HTTP_BODY_BYTES, MissionPolicyResponseSchema, ServiceAuthHeadersSchema } from "@koven/schemas";
import { ZodError } from "zod";

import type { CompletionService } from "./completion.js";
import type { CreditService } from "./credit.js";
import { fail, SignerError } from "./errors.js";
import { CIRCUIT_ID, type PaymentGate } from "./gate.js";
import type { RepaymentService } from "./repay.js";
import type { SignerStore } from "./store.js";

export interface SignerAppOptions {
  readonly store: SignerStore;
  readonly gate: PaymentGate;
  readonly credit: CreditService;
  readonly completion: CompletionService;
  readonly repayment: RepaymentService;
  readonly credentials: {
    readonly consumer: string;
    readonly orchestrator: string;
    readonly registrar: string;
    readonly lenders: Readonly<Record<string, string>>;
  };
  readonly now?: () => Date;
}

type Role = "consumer" | "orchestrator" | "registrar";

const equalCredentials = (presented: string, expected: string): boolean => {
  const left = Buffer.from(presented, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
};

function bearer(request: Request): string {
  const parsed = ServiceAuthHeadersSchema.safeParse({ authorization: request.get("authorization") });
  if (!parsed.success) fail(ErrorCode.AUTH_INVALID, "Missing or malformed service credential");
  return parsed.data.authorization.slice("Bearer ".length);
}

type Handler = (request: Request) => Promise<unknown> | unknown;

const route = (status: number, handler: Handler) => async (request: Request, response: Response, next: NextFunction) => {
  try {
    response.status(status).json(await handler(request));
  } catch (error) {
    next(error);
  }
};

/** Wires the frozen S0.1 signer routes to their services behind role credentials. */
export function createSignerApp(options: SignerAppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  const json = express.json({ limit: MAX_HTTP_BODY_BYTES, strict: true });
  const raw = express.raw({ type: () => true, limit: MAX_HTTP_BODY_BYTES });

  const requireRole = (request: Request, role: Role): void => {
    if (!equalCredentials(bearer(request), options.credentials[role])) {
      fail(ErrorCode.AUTH_INVALID, "Service credential is not authorized for this route");
    }
  };
  /** Lender identity comes from the credential mapping, never from the body. */
  const requireLender = (request: Request): string => {
    const presented = bearer(request);
    let account: string | undefined;
    for (const [token, accountId] of Object.entries(options.credentials.lenders)) {
      if (equalCredentials(presented, token)) account = accountId;
    }
    if (account === undefined) fail(ErrorCode.AUTH_INVALID, "Lender credential is not recognised");
    return account;
  };

  app.get("/health", route(200, () => HealthResponseSchema.parse({ status: "ok", circuitId: CIRCUIT_ID, vkeyHash: null })));

  app.post("/authorize", json, route(200, request => {
    requireRole(request, "consumer");
    return options.gate.authorize(request.body);
  }));

  app.post("/sign-credit-request", json, route(200, request => {
    requireRole(request, "consumer");
    return options.credit.signCreditRequest(request.body);
  }));

  app.post("/sign-credit-acceptance", json, route(200, request => {
    requireRole(request, "consumer");
    return options.credit.signCreditAcceptance(request.body);
  }));

  app.post("/internal/loans/register", json, route(200, request => (
    options.credit.registerLoan(requireLender(request), request.body)
  )));

  app.post("/internal/missions/register", json, route(200, request => {
    requireRole(request, "registrar");
    const now = (options.now ?? (() => new Date()))().toISOString();
    options.store.registerMissionPolicy(request.body, now);
    return MissionPolicyResponseSchema.parse({ missionId: request.body.missionId, status: "registered" });
  }));

  app.post("/internal/missions/complete", raw, route(202, request => options.completion.complete({
    body: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
    headers: {
      "idempotency-key": request.get("idempotency-key"),
      "x-callback-timestamp": request.get("x-callback-timestamp"),
      "x-callback-signature": request.get("x-callback-signature"),
    },
  })));

  app.post("/repay", json, route(200, request => {
    requireRole(request, "orchestrator");
    return options.repayment.repay(request.body);
  }));

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    let status = 500;
    let code: string = ErrorCode.INTERNAL_ERROR;
    let detail = "Restricted signer failed to process the request";
    if (error instanceof SignerError) {
      status = error.status;
      code = error.code;
      detail = error.message;
    } else if (error instanceof ZodError) {
      status = 400;
      code = ErrorCode.REQUEST_INVALID;
      detail = error.issues.map(issue => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ");
    } else if (typeof error === "object" && error !== null && "type" in error) {
      if (error.type === "entity.too.large") {
        status = 413;
        code = ErrorCode.SOURCE_TOO_LARGE;
        detail = "Request body exceeds the transport limit";
      } else if (error.type === "entity.parse.failed") {
        status = 400;
        code = ErrorCode.REQUEST_INVALID;
        detail = "Request body is not valid JSON";
      }
    }
    response.status(status).json(ErrorResponseSchema.parse({ code, detail }));
  });
  return app;
}
