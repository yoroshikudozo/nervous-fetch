import { DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES } from "@/lib/fetcher/consts";
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
import { isAbortError, isJsonContentType } from "@/lib/fetcher/utils";

/**
 * Read a body to text while enforcing the size cap in *bytes*.
 *
 * `text.length` after `response.text()` is wrong twice over: it counts UTF-16
 * code units, so multi-byte UTF-8 (Japanese is 3 bytes per character) slips
 * through at up to three times the limit — and the whole body is in memory by
 * then anyway, which is what the cap exists to prevent.
 */
async function readTextWithinCap(response: Response): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new ResponseTooLargeError(MAX_RESPONSE_BYTES);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    // Tear the connection down if we bailed out early. Not awaited: cancel()
    // settles only once the peer acknowledges, which a stalled connection may
    // never do — and we already have the result we are returning.
    void reader.cancel().catch(() => {});
  }
}

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
    text = await readTextWithinCap(response);
  } catch (error) {
    // The cap and an abort are already the right classification; anything else
    // that breaks mid-read is a dropped connection.
    if (error instanceof ResponseTooLargeError) throw error;
    if (isAbortError(error)) throw error;
    throw new NetworkError("Failed to read response body", error);
  }

  if (!text) return null;

  if (isJsonContentType(response)) {
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
// surface the same error types. `reason` is the abort reason that owns the
// timeout-vs-cancel precedence (see linkAbortSignal.getReason). Callers should
// `throw mapRequestError(...)`.
export function mapRequestError(
  error: unknown,
  reason: unknown,
  timeout: number,
): Error {
  // A caller cancel outranks a timeout that won the abort() reason race.
  if (reason === "external") return new AbortError(error);
  // Timeout is a special case of Abort, so check it next.
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
// `cleanup` detaches the listener and must be called in a finally. `getReason`
// returns the abort reason for error mapping, forcing external cancel to outrank
// a timeout that won the (idempotent) abort() reason race.
export function linkAbortSignal(external?: AbortSignal | null): {
  controller: AbortController;
  cleanup: () => void;
  getReason: () => unknown;
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

  const getReason = () =>
    external?.aborted ? "external" : controller.signal.reason;

  return { controller, cleanup, getReason };
}

export async function fetcher<T>(
  url: string,
  options: FetcherOptions = {},
): Promise<T> {
  const { timeout = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;
  const { controller, cleanup, getReason } = linkAbortSignal(fetchOptions.signal);
  const timeoutId = setTimeout(() => controller.abort("timeout"), timeout);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });

    const body = await parseResponse(response);

    if (!response.ok) {
      throw HTTPError.fromResponse(response, body);
    }

    return body as T;
  } catch (error) {
    throw mapRequestError(error, getReason(), timeout);
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

  // Normalize through Headers rather than spreading: a HeadersInit may be a
  // Headers instance (spreads to {}, dropping every header the caller set) or a
  // [key, value][] (spreads to {0: [...]}).
  const headers = new Headers(rest.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return {
    ...rest,
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
}
