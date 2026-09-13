import {
  validateCreditOffer,
  type SignedCreditAcceptance,
} from "@koven/credit-protocol";
import type {
  CreditOffer,
  CreditRequest,
  UnsignedCreditRequest,
} from "@koven/domain";
import { ErrorCode } from "@koven/domain";
import type { PublicKey } from "@koven/hedera";
import {
  CreditAcceptResponseSchema,
  CreditAcceptRequestSchema,
  CreditOfferSchema,
  CreditRequestSchema,
  ErrorResponseSchema,
  SignatureResponseSchema,
  SignedAcceptanceSchema,
  SignCreditAcceptanceSchema,
  SignCreditRequestSchema,
  type HttpRequest,
} from "@koven/schemas";

const SERVICE_CREDENTIAL = /^[A-Za-z0-9_-]{43,}$/;

export class ConsumerServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
  ) {
    super(detail);
    this.name = "ConsumerServiceError";
  }
}

export type CreditEvidence = Omit<HttpRequest<"signCreditAcceptance">, "offer">;

export interface ConsumerCreditSigner {
  signCreditRequest(request: UnsignedCreditRequest): Promise<CreditRequest>;
  signCreditAcceptance(
    offer: CreditOffer,
    evidence?: CreditEvidence,
  ): Promise<SignedCreditAcceptance>;
}

export interface ConsumerLender {
  quote(request: CreditRequest): Promise<CreditOffer | null>;
  accept(
    signed: SignedCreditAcceptance,
    evidence?: CreditEvidence,
  ): Promise<{ fundingTxId: string }>;
}

interface HttpClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

function trustedOrigin(value: string, label: string): URL {
  const url = new URL(value);
  const loopback = url.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !loopback)
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/"
  ) throw new Error(`${label} must be an HTTPS or loopback HTTP origin`);
  return url;
}

function validTimeout(value: number | undefined): number {
  const timeout = value ?? 30_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120_000) {
    throw new RangeError("HTTP timeout must be between 1 and 120000 ms");
  }
  return timeout;
}

async function serviceError(response: Response, fallback: string): Promise<ConsumerServiceError> {
  const error = ErrorResponseSchema.safeParse(await response.json().catch(() => undefined));
  return error.success
    ? new ConsumerServiceError(response.status, error.data.code, error.data.detail)
    : new ConsumerServiceError(response.status, ErrorCode.INTERNAL_ERROR, fallback);
}

const requestToWire = (request: UnsignedCreditRequest | CreditRequest) => ({
  ...request,
  principalTinybar: request.principalTinybar.toString(10),
});

const offerToWire = (offer: CreditOffer) => ({
  ...offer,
  principalTinybar: offer.principalTinybar.toString(10),
  feeTinybar: offer.feeTinybar.toString(10),
});

const offerFromWire = (wire: ReturnType<typeof CreditOfferSchema.parse>): CreditOffer => ({
  ...wire,
  principalTinybar: BigInt(wire.principalTinybar),
  feeTinybar: BigInt(wire.feeTinybar),
});

async function postJson(
  fetchImplementation: typeof fetch,
  url: URL,
  body: unknown,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetchImplementation(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export interface HttpCreditSignerOptions extends HttpClientOptions {
  /** Opaque consumer-role credential. */
  readonly credential: string;
}

/** Typed credit commands for the remote process that exclusively holds the consumer key. */
export class HttpCreditSigner implements ConsumerCreditSigner {
  private readonly baseUrl: URL;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpCreditSignerOptions) {
    this.baseUrl = trustedOrigin(options.baseUrl, "Restricted signer URL");
    if (!SERVICE_CREDENTIAL.test(options.credential)) throw new Error("Invalid signer credential");
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMs = validTimeout(options.timeoutMs);
  }

  async signCreditRequest(request: UnsignedCreditRequest): Promise<CreditRequest> {
    const body = SignCreditRequestSchema.parse({ request: requestToWire(request) });
    const response = await postJson(
      this.fetchImplementation,
      new URL("/sign-credit-request", this.baseUrl),
      body,
      this.timeoutMs,
      { authorization: `Bearer ${this.options.credential}` },
    );
    if (response.status !== 200) throw await serviceError(response, "Restricted signer refused the credit request");
    const { signature } = SignatureResponseSchema.parse(await response.json());
    return { ...request, signature };
  }

  async signCreditAcceptance(
    offer: CreditOffer,
    evidence: CreditEvidence = {},
  ): Promise<SignedCreditAcceptance> {
    const body = SignCreditAcceptanceSchema.parse({ offer: offerToWire(offer), ...evidence });
    const response = await postJson(
      this.fetchImplementation,
      new URL("/sign-credit-acceptance", this.baseUrl),
      body,
      this.timeoutMs,
      { authorization: `Bearer ${this.options.credential}` },
    );
    if (response.status !== 200) throw await serviceError(response, "Restricted signer refused the credit acceptance");
    const signed = SignedAcceptanceSchema.parse(await response.json());
    if (
      signed.acceptance.requestId !== offer.requestId
      || signed.acceptance.lenderAccountId !== offer.lenderAccountId
      || signed.acceptance.offerId !== offer.id
      || signed.acceptance.termsHash !== offer.termsHash
      || signed.acceptance.expiresAt !== offer.expiresAt
    ) throw new ConsumerServiceError(
      502,
      ErrorCode.CREDIT_ACCEPTANCE_INVALID,
      "Signer returned an acceptance for different terms",
    );
    const acceptance = {
      requestId: signed.acceptance.requestId,
      missionId: signed.acceptance.missionId,
      borrowerAccountId: signed.acceptance.borrowerAccountId,
      lenderAccountId: signed.acceptance.lenderAccountId,
      offerId: signed.acceptance.offerId,
      termsHash: signed.acceptance.termsHash,
      expiresAt: signed.acceptance.expiresAt,
      ...(signed.acceptance.paymentIntentHash === undefined
        ? {}
        : { paymentIntentHash: signed.acceptance.paymentIntentHash }),
      ...(signed.acceptance.paymentProofBundleHash === undefined
        ? {}
        : { paymentProofBundleHash: signed.acceptance.paymentProofBundleHash }),
    };
    return { acceptance, signature: signed.signature };
  }
}

export interface HttpLenderOptions extends HttpClientOptions {
  readonly publicKey: PublicKey;
  readonly now?: () => string;
}

/** HTTP lender adapter that verifies every returned offer before it can reach the signer. */
export class HttpLender implements ConsumerLender {
  private readonly baseUrl: URL;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => string;

  constructor(private readonly options: HttpLenderOptions) {
    this.baseUrl = trustedOrigin(options.baseUrl, "Lender URL");
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMs = validTimeout(options.timeoutMs);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async quote(request: CreditRequest): Promise<CreditOffer | null> {
    const body = CreditRequestSchema.parse(requestToWire(request));
    const response = await postJson(
      this.fetchImplementation,
      new URL("/credit/quote", this.baseUrl),
      body,
      this.timeoutMs,
    );
    if (response.status === 204) return null;
    if (response.status !== 200) throw await serviceError(response, "Lender refused the credit request");
    const offer = offerFromWire(CreditOfferSchema.parse(await response.json()));
    validateCreditOffer(offer, request, this.options.publicKey, this.now());
    return offer;
  }

  async accept(
    signed: SignedCreditAcceptance,
    evidence: CreditEvidence = {},
  ): Promise<{ fundingTxId: string }> {
    const body = CreditAcceptRequestSchema.parse({
      acceptance: signed.acceptance,
      signature: signed.signature,
      ...evidence,
    });
    let response: Response;
    try {
      response = await postJson(
        this.fetchImplementation,
        new URL("/credit/accept", this.baseUrl),
        body,
        this.timeoutMs,
      );
    } catch {
      throw new ConsumerServiceError(
        503,
        ErrorCode.SETTLEMENT_UNCONFIRMED,
        "Funding response was lost; retry the same acceptance",
      );
    }
    if (response.status !== 200) throw await serviceError(response, "Lender has not completed funding");
    return CreditAcceptResponseSchema.parse(await response.json());
  }
}
