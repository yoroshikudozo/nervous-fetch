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
  // 204 No Content と 304 Not Modified は body がない正常な状態
  if (response.status === 204 || response.status === 304) {
    return null;
  }

  // content-length があれば本文を読む前に上限チェック（早期拒否でメモリを守る）
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    throw new ResponseTooLargeError(MAX_RESPONSE_BYTES);
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // ストリーム読み込み失敗はNetworkErrorとして扱う
    throw new NetworkError("Failed to read response body", error);
  }

  // content-length が無い（chunked等）場合に備え、読み終えた実サイズで再チェック
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

export async function fetcher<T>(
  url: string,
  options: FetcherOptions = {},
): Promise<T> {
  const { timeout = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;

  if (fetchOptions.signal?.aborted) throw new AbortError();

  const controller = new AbortController();
  const onAbort = () => controller.abort("external");
  fetchOptions.signal?.addEventListener("abort", onAbort);

  // 登録後に再チェック（addEventListener前にabortされていた場合の競合対策）
  if (fetchOptions.signal?.aborted) {
    controller.abort("external");
    throw new AbortError();
  }

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
    throw mapRequestError(error, controller.signal.reason, timeout);
  } finally {
    clearTimeout(timeoutId);
    fetchOptions.signal?.removeEventListener("abort", onAbort);
  }
}

export function buildMutationOptions(
  method: string,
  options: MutationOptions,
): FetcherOptions {
  const { body, ...rest } = options;

  if (body instanceof FormData) {
    // FormDataはfetchが自動でContent-Typeをセットするので手動でセットしない
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
