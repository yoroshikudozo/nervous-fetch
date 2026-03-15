import { DEFAULT_TIMEOUT_MS, StatusCode } from "@/lib/fetcher/consts";
import {
  AbortError,
  HTTPError,
  NetworkError,
  ParseError,
  TimeoutError,
} from "@/lib/fetcher/errors";
import { FetcherOptions } from "@/lib/fetcher/types";
import { isAbortError } from "@/lib/fetcher/utils";

export async function fetcher<T>(
  url: string,
  options: FetcherOptions = {},
): Promise<T> {
  const { timeout = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;

  if (fetchOptions.signal?.aborted) throw new AbortError();

  const controller = new AbortController();

  const onAbort = () => controller.abort("external");
  fetchOptions.signal?.addEventListener("abort", onAbort);

  const timeoutId = setTimeout(() => controller.abort("timeout"), timeout);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new HTTPError(
        response.status as StatusCode,
        response.statusText,
        body,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (cause) {
      throw new ParseError("Failed to parse response as JSON", cause);
    }
  } catch (error) {
    if (controller.signal.reason === "timeout")
      throw new TimeoutError(timeout, error);
    if (isAbortError(error)) throw new AbortError(error);
    if (error instanceof TypeError)
      throw new NetworkError(error.message, error);
    throw error;
  } finally {
    clearTimeout(timeoutId);
    fetchOptions.signal?.removeEventListener("abort", onAbort);
  }
}
