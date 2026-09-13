import { ErrorCode, type ErrorCode as DomainErrorCode, type RankedProvider } from "@koven/domain";
import {
  ErrorResponseSchema,
  ProviderRankResponseSchema,
  type HttpRequest,
} from "@koven/schemas";

export interface ProviderRankingResult {
  readonly ranked: readonly RankedProvider[];
  readonly formula: string;
}

export interface ProviderDirectory {
  rank(input: HttpRequest<"rankProviders">): Promise<ProviderRankingResult>;
}

export class ProviderDirectoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: DomainErrorCode,
    detail: string,
  ) {
    super(detail);
    this.name = "ProviderDirectoryError";
  }
}

export interface HttpProviderDirectoryOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

function trustedOrigin(value: string): URL {
  const url = new URL(value);
  const loopback = url.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !loopback)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/"
  ) throw new Error("Provider directory must be an HTTPS or loopback HTTP origin");
  return url;
}

const rankedProviderFromWire = (
  candidate: ReturnType<typeof ProviderRankResponseSchema.parse>["ranked"][number],
): RankedProvider => ({
  ...candidate,
  provider: {
    ...candidate.provider,
    priceTinybar: BigInt(candidate.provider.priceTinybar),
  },
});

/** HTTP adapter for deterministic provider ranking from the event-backed directory. */
export class HttpProviderDirectory implements ProviderDirectory {
  private readonly baseUrl: URL;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpProviderDirectoryOptions) {
    this.baseUrl = trustedOrigin(options.baseUrl);
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new RangeError("Provider directory timeout must be between 1 and 120000 ms");
    }
  }

  async rank(input: HttpRequest<"rankProviders">): Promise<ProviderRankingResult> {
    const url = new URL("/providers/rank", this.baseUrl);
    url.searchParams.set("capability", input.capability);
    url.searchParams.set("maxPriceTinybar", input.maxPriceTinybar);
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ProviderDirectoryError(
        503,
        ErrorCode.INTERNAL_ERROR,
        "Provider directory is unavailable",
      );
    }
    if (response.status !== 200) {
      const error = ErrorResponseSchema.safeParse(await response.json().catch(() => undefined));
      throw error.success
        ? new ProviderDirectoryError(response.status, error.data.code, error.data.detail)
        : new ProviderDirectoryError(response.status, ErrorCode.INTERNAL_ERROR, "Provider directory request failed");
    }
    const result = ProviderRankResponseSchema.parse(await response.json());
    return {
      ranked: result.ranked.map(rankedProviderFromWire),
      formula: result.formula,
    };
  }
}
