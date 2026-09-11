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
  CallbackHeadersSchema,
  CallbackResponseSchema,
  CompletionCallbackSchema,
  CreateMissionRequestSchema,
  ErrorResponseSchema,
  MissionDetailResponseSchema,
  MissionParamsSchema,
  MissionSchema,
} from "@koven/schemas";
import { ZodError, type ZodType } from "zod";

import { CallbackAuthenticationError, type CompletionHandler } from "../callbacks/index.js";
import type { MissionWorkflow } from "../workflows/index.js";

export interface OrchestratorAppOptions {
  database: KovenDatabase;
  workflow: MissionWorkflow;
  completionHandler: CompletionHandler;
}

class ResponseContractError extends Error {}

const isMalformedJson = (error: unknown): boolean => error instanceof SyntaxError
  && "type" in error
  && error.type === "entity.parse.failed";

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
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

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
    const callback = CompletionCallbackSchema.parse(request.body);
    const headers = CallbackHeadersSchema.parse({
      "idempotency-key": request.get("idempotency-key"),
      "x-callback-timestamp": request.get("x-callback-timestamp"),
      "x-callback-signature": request.get("x-callback-signature"),
    });
    const result = await options.completionHandler.receive(callback, {
      idempotencyKey: headers["idempotency-key"],
      timestamp: headers["x-callback-timestamp"],
      signature: headers["x-callback-signature"],
    });
    response.json(responseContract(CallbackResponseSchema, result));
  }));

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    let status = 500;
    let code: ErrorCode = ErrorCode.INTERNAL_ERROR;
    let detail = "Internal server error";

    if (error instanceof ZodError || isMalformedJson(error)) {
      status = 400;
      code = ErrorCode.REQUEST_INVALID;
      detail = error instanceof ZodError
        ? error.issues.map(issue => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ")
        : "Request body must contain valid JSON";
    } else if (error instanceof CallbackAuthenticationError) {
      status = 401;
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
