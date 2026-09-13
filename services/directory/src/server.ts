import express, { type Application, type ErrorRequestHandler } from "express";
import { ErrorCode, type Provider, type RankedProvider } from "@koven/domain";
import type { KovenDatabase } from "@koven/persistence";
import { PROVIDER_RANKING_FORMULA, rankProviders } from "@koven/policy";
import {
  ErrorResponseSchema,
  ProviderRankQuerySchema,
  ProviderRankResponseSchema,
  ProvidersResponseSchema,
} from "@koven/schemas";
import { ZodError } from "zod";

import { ProviderRegistry } from "./registry.js";
import { getProviderReputations, REPUTATION_FORMULA } from "./reputation.js";

export const DIRECTORY_RANKING_FORMULA =
  `${PROVIDER_RANKING_FORMULA}; reputation = ${REPUTATION_FORMULA}`;

export interface DirectoryAppOptions {
  readonly database: KovenDatabase;
  readonly registry: ProviderRegistry;
}

const providerToWire = (provider: Provider) => ({
  ...provider,
  priceTinybar: provider.priceTinybar.toString(10),
});

const rankedProviderToWire = (ranked: RankedProvider) => ({
  ...ranked,
  provider: providerToWire(ranked.provider),
});

/** Creates the local provider directory over immutable metadata and the authoritative event log. */
export function createDirectoryApp(options: DirectoryAppOptions): Application {
  const app = express();
  app.disable("x-powered-by");

  const providers = (): Provider[] => {
    const records = options.registry.list();
    const reputations = getProviderReputations(options.database, records.map(record => record.id));
    return records.map(record => ({
      ...record,
      reputationScore: reputations.get(record.id)!.score,
    }));
  };

  app.get("/providers", (_request, response) => {
    response.json(ProvidersResponseSchema.parse(providers().map(providerToWire)));
  });

  app.get("/providers/rank", (request, response) => {
    const query = ProviderRankQuerySchema.parse({
      capability: request.query.capability,
      maxPriceTinybar: request.query.maxPriceTinybar,
    });
    const ranked = rankProviders(providers(), {
      capability: query.capability,
      maxPriceTinybar: BigInt(query.maxPriceTinybar),
    });
    response.json(ProviderRankResponseSchema.parse({
      ranked: ranked.map(rankedProviderToWire),
      formula: DIRECTORY_RANKING_FORMULA,
    }));
  });

  const errors: ErrorRequestHandler = (error, _request, response, _next) => {
    const requestError = error instanceof ZodError;
    const body = ErrorResponseSchema.parse({
      code: requestError ? ErrorCode.REQUEST_INVALID : ErrorCode.INTERNAL_ERROR,
      detail: requestError ? "Directory request is invalid" : "Directory request failed",
    });
    response.status(requestError ? 400 : 500).json(body);
  };
  app.use(errors);
  return app;
}
