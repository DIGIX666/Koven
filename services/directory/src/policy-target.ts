import { ErrorCode } from "@koven/domain";
import {
  ErrorResponseSchema,
  MissionPolicyRequestSchema,
  MissionPolicyResponseSchema,
  type HttpRequest,
} from "@koven/schemas";



const SERVICE_CREDENTIAL = /^[A-Za-z0-9_-]{43,}$/;

export class MissionPolicyRegistrationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
  ) {
    super(detail);
    this.name = "MissionPolicyRegistrationError";
  }
}

function trustedOrigin(value: string): URL {
  const url = new URL(value);
  const loopback = url.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !loopback)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/"
  ) throw new Error("Policy target must be an HTTPS or loopback HTTP origin");
  return url;
}

export interface HttpMissionPolicyTargetOptions {
  readonly baseUrl: string;
  readonly credential: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Provisions the immutable mission policy through an authenticated service boundary. */
export class HttpMissionPolicyTarget {
  private readonly baseUrl: URL;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpMissionPolicyTargetOptions) {
    this.baseUrl = trustedOrigin(options.baseUrl);
    if (!SERVICE_CREDENTIAL.test(options.credential)) throw new Error("Invalid policy registrar credential");
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new RangeError("Policy registration timeout must be between 1 and 120000 ms");
    }
  }

  async register(input: HttpRequest<"registerMissionPolicy">): Promise<void> {
    const policy = MissionPolicyRequestSchema.parse(input);
    let response: Response;
    try {
      response = await this.fetchImplementation(new URL("/internal/missions/register", this.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(policy),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new MissionPolicyRegistrationError(
        503,
        ErrorCode.SETTLEMENT_UNCONFIRMED,
        "Mission policy target is unavailable",
      );
    }
    if (response.status !== 200) {
      const error = ErrorResponseSchema.safeParse(await response.json().catch(() => undefined));
      throw error.success
        ? new MissionPolicyRegistrationError(response.status, error.data.code, error.data.detail)
        : new MissionPolicyRegistrationError(response.status, ErrorCode.INTERNAL_ERROR, "Mission policy was refused");
    }
    const result = MissionPolicyResponseSchema.parse(await response.json());
    if (result.missionId !== policy.missionId) {
      throw new MissionPolicyRegistrationError(502, ErrorCode.INTERNAL_ERROR, "Another mission policy was acknowledged");
    }
  }
}
