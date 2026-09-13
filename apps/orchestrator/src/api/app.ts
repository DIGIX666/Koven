import express, { type Application, type ErrorRequestHandler, type RequestHandler } from "express";
import { ErrorCode, IllegalStateTransitionError } from "@koven/domain";
import {
  getMission,
  listMissionEvents,
  PersistenceConflictError,
  PersistenceNotFoundError,
  type KovenDatabase,
  type PersistedMission,
} from "@koven/persistence";
import {
  CallbackResponseSchema,
  CreateMissionRequestSchema,
  ErrorResponseSchema,
  MAX_HTTP_BODY_BYTES,
  MissionDetailResponseSchema,
  MissionParamsSchema,
  MissionSchema,
} from "@koven/schemas";
import { ZodError, type ZodType } from "zod";

import { CompletionError, type CompletionHandler } from "../callbacks/index.js";
import {
  ProviderDirectoryError,
  RepaymentRequestError,
  type MissionWorkflow,
  type RepaymentWorkflow,
} from "../workflows/index.js";

export interface OrchestratorAppOptions {
  database: KovenDatabase;
  workflow: MissionWorkflow;
  completionHandler: CompletionHandler;
  repaymentWorkflow: RepaymentWorkflow;
}

class ResponseContractError extends Error {}

const isMalformedJson = (error: unknown): boolean => error instanceof SyntaxError
  && "type" in error
  && error.type === "entity.parse.failed";

const isBodyTooLarge = (error: unknown): boolean => error instanceof Error
  && "type" in error
  && error.type === "entity.too.large";

const asyncRoute = (handler: RequestHandler): RequestHandler => (request, response, next) => {
  Promise.resolve(handler(request, response, next)).catch(next);
};

const responseContract = <T>(schema: ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ResponseContractError(parsed.error.message);
  return parsed.data;
};

const missionResponse = (mission: PersistedMission) => ({
  id: mission.id,
  state: mission.state,
  spendingCapTinybar: mission.spendingCapTinybar.toString(10),
  spentTinybar: mission.spentTinybar.toString(10),
  approvedRecipientsRoot: mission.approvedRecipientsRoot,
  targetRef: mission.targetRef,
  targetSha256: mission.targetSha256,
  createdAt: mission.createdAt,
  updatedAt: mission.updatedAt,
});

export function createOrchestratorApp(options: OrchestratorAppOptions): Application {
  const app = express();
  const rawBodies = new WeakMap<object, Buffer>();
  app.disable("x-powered-by");
  app.use(express.json({
    limit: MAX_HTTP_BODY_BYTES,
    verify: (request, _response, body) => rawBodies.set(request, Buffer.from(body)),
  }));

  app.post("/missions", asyncRoute(async (request, response) => {
    const input = CreateMissionRequestSchema.parse(request.body);
    const mission = await options.workflow.run(input);
    response.status(201).json(responseContract(MissionSchema, missionResponse(mission)));
  }));

  app.get("/missions/:id", asyncRoute(async (request, response) => {
    const { id } = MissionParamsSchema.parse(request.params);
    const mission = getMission(options.database, id);
    if (mission === undefined) throw new PersistenceNotFoundError("mission", id);
    const events = listMissionEvents(options.database, id).map(({
      payload: _payload,
      publishedAt: _publishedAt,
      ...event
    }) => event);
    response.json(responseContract(MissionDetailResponseSchema, {
      ...missionResponse(mission),
      events,
    }));
  }));

  app.post("/callbacks/mission-complete", asyncRoute(async (request, response) => {
    const result = await options.completionHandler.receive({
      body: rawBodies.get(request) ?? Buffer.alloc(0),
      headers: {
        idempotencyKey: request.get("idempotency-key"),
        timestamp: request.get("x-callback-timestamp"),
        signature: request.get("x-callback-signature"),
      },
    });
    await options.repaymentWorkflow.run(result.missionId);
    response.status(202).json(responseContract(CallbackResponseSchema, result.response));
  }));

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    let status = 500;
    let code: ErrorCode = ErrorCode.INTERNAL_ERROR;
    let detail = "Internal server error";

    if (isBodyTooLarge(error)) {
      status = 413;
      code = ErrorCode.SOURCE_TOO_LARGE;
      detail = "Request body exceeds the transport limit";
    } else if (error instanceof ZodError || isMalformedJson(error)) {
      status = 400;
      code = ErrorCode.REQUEST_INVALID;
      detail = error instanceof ZodError
        ? error.issues.map(issue => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ")
        : "Request body must contain valid JSON";
    } else if (
      error instanceof CompletionError
      || error instanceof ProviderDirectoryError
      || error instanceof RepaymentRequestError
    ) {
      status = error.status;
      code = error.code;
      detail = error.message;
    } else if (error instanceof PersistenceNotFoundError) {
      status = 404;
      code = ErrorCode.NOT_FOUND;
      detail = error.message;
    } else if (error instanceof IllegalStateTransitionError) {
      status = 409;
      code = error.code;
      detail = error.message;
    } else if (error instanceof PersistenceConflictError) {
      status = 409;
      const domainCodes = Object.values(ErrorCode) as string[];
      code = domainCodes.includes(error.conflict)
        ? error.conflict as ErrorCode
        : ErrorCode.INTERNAL_ERROR;
      detail = error.message;
    } else if (error instanceof ResponseContractError) {
      detail = "Response violated its contract";
    }

    response.status(status).json(ErrorResponseSchema.parse({ code, detail }));
  };
  app.use(errorHandler);
  return app;
}
