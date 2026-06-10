import {
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  StatusCode,
} from "@/lib/fetcher/consts";
import {
  AbortError,
  HTTPError,
  NetworkError,
  ParseError,
  ResponseTooLargeError,
  TimeoutError,
  UnknownFetchError,
} from "@/lib/fetcher/errors";
import { FetcherOptions, MutationOptions } from "@/lib/fetcher/types";
import { isAbortError } from "@/lib/fetcher/utils";

async function parseResponse(response: Response): Promise<unknown> {
  // 204 No Content and 304 Not Modified are valid responses with no body.
  if (response.status === 204 || response.status === 304) {
    return null;
  }

  // If content-length is present, enforce the cap before reading the body (reject early to protect memory).
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    throw new ResponseTooLargeError(MAX_RESPONSE_BYTES);
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // Treat a stream read failure as a NetworkError.
    throw new NetworkError("Failed to read response body", error);
  }

  // In case content-length is absent (e.g. chunked), re-check against the actual read size.
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new ResponseTooLargeError(MAX_RESPONSE_BYTES);
  }

  const contentType = response.headers.get("content-type");
  const isJson = contentType?.includes("application/json");

  if (!text) return null;

  if (isJson) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new ParseError("Failed to parse response as JSON", error);
    }
  }

  return text;
}

// Map a failure from a single fetch lifecycle onto the custom error hierarchy.
// Shared by the buffered fetcher and the streaming version (stream.ts) so both
// surface the same error types. Callers should `throw mapRequestError(...)`.
export function mapRequestError(
  error: unknown,
  reason: unknown,
  timeout: number,
): Error {
  // Timeout is a special case of Abort, so check it first.
  if (reason === "timeout") return new TimeoutError(timeout, error);
  if (isAbortError(error)) return new AbortError(error);
  if (error instanceof TypeError) return new NetworkError("Network error", error);
  // Pass known custom errors through unchanged.
  if (
    error instanceof HTTPError ||
    error instanceof NetworkError ||
    error instanceof ParseError ||
    error instanceof ResponseTooLargeError
  )
    return error;
  // Wrap unexpected errors in UnknownFetchError.
  return new UnknownFetchError(
    error instanceof Error ? error.message : "Unknown error",
    error,
  );
}

// Link an optional external AbortSignal to a fresh AbortController whose signal
// we pass to fetch, so a timeout (controller) and a caller cancel (external)
// share one signal. Shared by the buffered fetcher and streaming reader. Throws
// AbortError immediately if the external signal is already aborted; the returned
// `cleanup` detaches the listener and must be called in a finally.
export function linkAbortSignal(external?: AbortSignal | null): {
  controller: AbortController;
  cleanup: () => void;
} {
  if (external?.aborted) throw new AbortError();

  const controller = new AbortController();
  const onAbort = () => controller.abort("external");
  external?.addEventListener("abort", onAbort);
  const cleanup = () => external?.removeEventListener("abort", onAbort);

  // Re-check after registering, in case it aborted in the window before addEventListener ran.
  if (external?.aborted) {
    controller.abort("external");
    cleanup();
    throw new AbortError();
  }

  return { controller, cleanup };
}

export async function fetcher<T>(
  url: string,
  options: FetcherOptions = {},
): Promise<T> {
  const { timeout = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;
  const { controller, cleanup } = linkAbortSignal(fetchOptions.signal);
  const timeoutId = setTimeout(() => controller.abort("timeout"), timeout);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });

    const body = await parseResponse(response);

    if (!response.ok) {
      throw new HTTPError(
        response.status as StatusCode,
        response.statusText,
        body,
      );
    }

    return body as T;
  } catch (error) {
    // If the external signal aborted, throw AbortError reliably even when a race
    // with the timeout overwrote the reason with "timeout".
    if (fetchOptions.signal?.aborted) throw new AbortError(error);
    throw mapRequestError(error, controller.signal.reason, timeout);
  } finally {
    clearTimeout(timeoutId);
    cleanup();
  }
}

export function buildMutationOptions(
  method: string,
  options: MutationOptions,
): FetcherOptions {
  const { body, ...rest } = options;

  if (body instanceof FormData) {
    // fetch sets Content-Type automatically for FormData, so don't set it manually.
    return { ...rest, method, body };
  }

  return {
    ...rest,
    method,
    headers: {
      "Content-Type": "application/json",
      ...rest.headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
}
