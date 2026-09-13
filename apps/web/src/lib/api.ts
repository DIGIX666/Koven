import {
  HealthResponseSchema,
  MissionDetailResponseSchema,
  ProviderRankResponseSchema,
  ProvidersResponseSchema,
  type HttpResponse,
} from "@koven/schemas";

interface Schema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { message: string } };
}

export interface DashboardApiOptions {
  orchestratorUrl?: string;
  directoryUrl?: string;
  signerUrl?: string;
  fetch?: typeof fetch;
}

export interface ProviderRankInput {
  capability: string;
  maxPriceTinybar: string;
}

export class DashboardApiError extends Error {
  constructor(
    message: string,
    readonly kind: "configuration" | "input" | "network" | "http" | "contract",
    readonly status?: number,
  ) {
    super(message);
    this.name = "DashboardApiError";
  }
}

const DEFAULT_ORCHESTRATOR_URL = "http://127.0.0.1:3001";
const DEFAULT_DIRECTORY_URL = "http://127.0.0.1:3002";
const DEFAULT_SIGNER_URL = "http://127.0.0.1:3004";

const browserProxyUrl = (): string | undefined => typeof window === "undefined"
  ? undefined
  : `${window.location.origin}/api`;

function serviceUrl(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash) {
      throw new Error("unsafe URL");
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    throw new DashboardApiError(`Invalid dashboard service URL: ${raw}`, "configuration");
  }
}

async function request<T>(
  fetcher: typeof fetch,
  url: string,
  schema: Schema<T>,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    const init: RequestInit = {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      ...(signal ? { signal } : {}),
    };
    response = await fetcher(url, init);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new DashboardApiError(`Unable to reach ${new URL(url).origin}`, "network");
  }

  if (!response.ok) {
    throw new DashboardApiError(`Dashboard request failed with HTTP ${response.status}`, "http", response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DashboardApiError("Dashboard service returned invalid JSON", "contract", response.status);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new DashboardApiError(`Dashboard response violated its contract: ${parsed.error.message}`, "contract", response.status);
  }
  return parsed.data;
}

export class DashboardApi {
  private readonly orchestratorUrl: string;
  private readonly directoryUrl: string;
  private readonly signerUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: DashboardApiOptions = {}) {
    const proxyUrl = browserProxyUrl();
    this.orchestratorUrl = serviceUrl(
      options.orchestratorUrl ?? proxyUrl ?? process.env.NEXT_PUBLIC_ORCHESTRATOR_API_URL,
      DEFAULT_ORCHESTRATOR_URL,
    );
    this.directoryUrl = serviceUrl(
      options.directoryUrl ?? proxyUrl ?? process.env.NEXT_PUBLIC_DIRECTORY_API_URL,
      DEFAULT_DIRECTORY_URL,
    );
    // The browser reaches the signer only through the same-origin proxy, and
    // only its unauthenticated health route (pinned circuit and key hash).
    this.signerUrl = serviceUrl(
      options.signerUrl ?? (proxyUrl === undefined ? process.env.NEXT_PUBLIC_SIGNER_API_URL : `${proxyUrl}/signer`),
      DEFAULT_SIGNER_URL,
    );
    this.fetcher = options.fetch ?? fetch;
  }

  mission(id: string, signal?: AbortSignal): Promise<HttpResponse<"missionDetail">> {
    const missionId = id.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(missionId)) {
      throw new DashboardApiError("Mission id is invalid", "input");
    }
    return request(
      this.fetcher,
      `${this.orchestratorUrl}/missions/${encodeURIComponent(missionId)}`,
      MissionDetailResponseSchema,
      signal,
    );
  }

  /** The restricted signer's public health: `circuitId` and the `vkeyHash` it pinned (null in deterministic mode). */
  signerHealth(signal?: AbortSignal): Promise<HttpResponse<"health">> {
    return request(this.fetcher, `${this.signerUrl}/health`, HealthResponseSchema, signal);
  }

  providers(signal?: AbortSignal): Promise<HttpResponse<"providers">> {
    return request(this.fetcher, `${this.directoryUrl}/providers`, ProvidersResponseSchema, signal);
  }

  rankedProviders(input: ProviderRankInput, signal?: AbortSignal): Promise<HttpResponse<"rankProviders">> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.capability)) {
      throw new DashboardApiError("Provider capability is invalid", "input");
    }
    if (!/^(0|[1-9]\d*)$/.test(input.maxPriceTinybar)) {
      throw new DashboardApiError("Maximum price must be canonical tinybar", "input");
    }
    const query = new URLSearchParams({
      capability: input.capability,
      maxPriceTinybar: input.maxPriceTinybar,
    });
    return request(
      this.fetcher,
      `${this.directoryUrl}/providers/rank?${query.toString()}`,
      ProviderRankResponseSchema,
      signal,
    );
  }
}

export const dashboardApi = new DashboardApi();

/** Keeps route handlers from forwarding upstream bodies or internal addresses. */
export function dashboardErrorResponse(error: unknown): Response {
  if (error instanceof DashboardApiError) {
    const status = error.kind === "input" ? 400 : error.kind === "configuration" || error.kind === "contract"
      ? 502
      : error.kind === "http" && error.status === 404 ? 404 : 503;
    return Response.json({ error: error.message }, { status });
  }
  return Response.json({ error: "Dashboard data is unavailable" }, { status: 503 });
}
