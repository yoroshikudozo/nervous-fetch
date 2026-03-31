import { STATUS_CODE } from "@/lib/fetcher/consts";

import {
  AbortError,
  HTTPError,
  NetworkError,
  ParseError,
  TimeoutError,
} from "./errors";

export const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException ||
  (error instanceof Error &&
    (error.name === "AbortError" || error.message?.includes("aborted")));

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

export function toErrorResponse(error: unknown, source = "external"): Response {
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
