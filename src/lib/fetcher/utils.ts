import { STATUS_CODE } from "@/lib/fetcher/consts";

import {
  AbortError,
  HTTPError,
  NetworkError,
  ParseError,
  TimeoutError,
  UnknownFetchError,
} from "./errors";

// browser / Node.js 18+ native fetch
const isNativeAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

// server-side polyfill (e.g. node-fetch)
const isPolyfillAbort = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

// fallback for environments that set neither DOMException nor name
const isLegacyAbort = (error: unknown): boolean =>
  error instanceof Error && (error.message?.includes("aborted") ?? false);

export const isAbortError = (error: unknown): boolean =>
  isNativeAbort(error) || isPolyfillAbort(error) || isLegacyAbort(error);

export const isStatusCodeRetryable = (
  status: number,
  retryOn: number[],
): boolean => retryOn.includes(status);

export const isRetryable = (error: Error, retryOn: number[]): boolean => {
  if (error instanceof AbortError) return false;
  if (error instanceof ParseError) return false;
  if (error instanceof HTTPError)
    return isStatusCodeRetryable(error.status, retryOn);
  return true;
};

export const isJsonContentType = (response: Response): boolean => {
  const contentType = response.headers.get("content-type");
  return contentType?.includes("application/json") ?? false;
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
  if (error instanceof HTTPError) {
    return Response.json(
      { error: error.message, source },
      { status: error.status },
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
