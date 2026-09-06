import {
  MAX_RETRY_COUNT,
  MAX_RETRY_DELAY_MS,
  RETRY_BASE_DELAY_MS,
  STATUS_CODE,
} from "@/lib/fetcher/consts";

import {
  AbortError,
  HTTPError,
  NetworkError,
  ParseError,
  ResponseTooLargeError,
  TimeoutError,
  UnknownFetchError,
} from "./errors";

// Native fetch (a DOMException, which inherits from Error) and server-side
// polyfills both set `name`, so the name is the whole test. Sniffing the message
// for "aborted" is deliberately absent: an upstream error that merely mentions
// the word would be misfiled as a cancel and silently dropped from retry.
export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

export const isStatusCodeRetryable = (
  status: number,
  retryOn: number[],
): boolean => retryOn.includes(status);

// Idempotent per RFC 9110: sending twice has the same effect as sending once.
// POST and PATCH are absent by design — repeating them creates a second record.
// (PUT/DELETE hold only if the server implements them that way, as the RFC asks.)
const IDEMPOTENT_METHODS = new Set([
  "GET",
  "HEAD",
  "PUT",
  "DELETE",
  "OPTIONS",
  "TRACE",
]);

export const isMethodIdempotent = (method?: string): boolean =>
  method === undefined || IDEMPOTENT_METHODS.has(method.toUpperCase());

/**
 * Whether a failed request may be retried. Pass `method` for anything that is
 * not a plain GET: a timeout cannot tell us whether the server already applied
 * the write, so a non-idempotent one is never replayed.
 *
 * The retryable set is an allowlist, not a fallthrough — UnknownFetchError wraps
 * something we did not anticipate, so we do not assume replaying it is safe.
 */
export const isRetryable = (
  error: Error,
  retryOn: number[],
  method?: string,
): boolean => {
  if (!isMethodIdempotent(method)) return false;
  if (error instanceof HTTPError)
    return isStatusCodeRetryable(error.status, retryOn);
  return error instanceof NetworkError || error instanceof TimeoutError;
};

// Spread added on top of a server-requested wait: small enough to still honor
// the instruction, large enough to decorrelate clients.
const JITTER_RATIO = 0.2;

export interface RetryPlanOptions {
  /** Status codes worth retrying (HTTPError only). */
  retryOn: number[];
  /** Request method; a non-idempotent one is never replayed. */
  method?: string;
  /** How many retries are allowed in total. */
  maxRetries?: number;
  baseDelayMs?: number;
  /** Longest wait worth holding the request open for; a `Retry-After` beyond
   * this gives up instead of stalling. */
  maxDelayMs?: number;
}

/**
 * Decide whether to retry, and how long to wait first: the delay in ms, or
 * `null` to give up. Separate from the SWR wiring so the policy is testable.
 *
 * `attempt` is 1-based, matching the `retryCount` SWR hands to `onErrorRetry`.
 *
 * Backoff is exponential with equal jitter (half fixed, half random) so clients
 * that failed together don't retry in lockstep. A server's `Retry-After` can
 * lengthen that wait but never shorten it, so a server answering "1ms" can't be
 * turned into a retry loop — and jitter is re-applied on top, since an HTTP-date
 * is an absolute instant every client would otherwise return at together.
 */
export function planRetry(
  error: Error,
  attempt: number,
  {
    retryOn,
    method,
    maxRetries = MAX_RETRY_COUNT,
    baseDelayMs = RETRY_BASE_DELAY_MS,
    maxDelayMs = MAX_RETRY_DELAY_MS,
  }: RetryPlanOptions,
): number | null {
  if (!isRetryable(error, retryOn, method)) return null;
  if (attempt > maxRetries) return null;

  const window = baseDelayMs * 2 ** (attempt - 1);
  const backoff = window / 2 + Math.random() * (window / 2);

  const requested = error instanceof HTTPError ? error.retryAfterMs : undefined;
  if (requested === undefined) return backoff;
  // A wait we are not willing to sit out is a retry we should not make: holding
  // a request pending for minutes is worse for the caller than failing now.
  if (requested > maxDelayMs) return null;

  const delay = Math.max(requested, backoff);
  return delay + Math.random() * delay * JITTER_RATIO;
}

// `application/json` plus the structured-suffix family (`problem+json`,
// `vnd.api+json`), ignoring parameters such as `; charset=utf-8`.
export const isJsonContentType = (response: Response): boolean => {
  const contentType = response.headers.get("content-type");
  if (!contentType) return false;
  const [essence = ""] = contentType.toLowerCase().split(";");
  const type = essence.trim();
  return type === "application/json" || type.endsWith("+json");
};

// Where an error originated, as reported to the client. `external` = the
// outbound request the fetcher made; `api_route` = this route's own code.
export type ErrorSource = "external" | "api_route";

export function toErrorResponse(
  error: unknown,
  source: ErrorSource = "external",
): Response {
  if (error instanceof AbortError) {
    return Response.json(
      { error: error.message, source },
      { status: STATUS_CODE.CLIENT_CLOSED_REQUEST },
    );
  }
  if (error instanceof TimeoutError) {
    return Response.json(
      { error: error.message, source },
      { status: STATUS_CODE.GATEWAY_TIMEOUT },
    );
  }
  if (error instanceof NetworkError) {
    return Response.json(
      { error: error.message, source },
      { status: STATUS_CODE.BAD_GATEWAY },
    );
  }
  if (error instanceof ParseError) {
    return Response.json(
      { error: error.message, source },
      { status: STATUS_CODE.BAD_GATEWAY },
    );
  }
  if (error instanceof ResponseTooLargeError) {
    return Response.json(
      { error: error.message, source },
      { status: STATUS_CODE.PAYLOAD_TOO_LARGE },
    );
  }
  if (error instanceof HTTPError) {
    // Relay the upstream's pacing instruction — this route is the last place
    // that knows it — as delay-seconds, the absolute date being resolved already.
    const retryAfter =
      error.retryAfterMs === undefined
        ? undefined
        : { "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)) };
    return Response.json(
      { error: error.message, source },
      { status: error.status, headers: retryAfter },
    );
  }
  // Thrown by the fetcher when it wraps an unexpected error from the outbound
  // request path, so the origin is the external call — keep `source`. Never
  // echo the wrapped message to the client: it can carry internal details
  // (DB hosts, file paths, stack hints) that aid an attacker. Log it instead.
  if (error instanceof UnknownFetchError) {
    console.error("Unexpected fetcher error:", error);
    return Response.json(
      { error: "Internal Server Error", source },
      { status: STATUS_CODE.INTERNAL_SERVER_ERROR },
    );
  }

  // Anything reaching here was not produced by the fetcher (no typed wrapper),
  // so the origin is this API route itself — tag it `api_route`. Same no-leak
  // rule applies: log the real error, return a generic message.
  console.error("Unhandled error in route handler:", error);
  return Response.json(
    { error: "Internal Server Error", source: "api_route" },
    { status: STATUS_CODE.INTERNAL_SERVER_ERROR },
  );
}

export function withErrorHandling(
  handler: (req: Request) => Promise<Response>,
) {
  return async (req: Request): Promise<Response> => {
    try {
      return await handler(req);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}
