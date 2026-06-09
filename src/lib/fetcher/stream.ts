import { mapRequestError } from "@/lib/fetcher/core";
import {
  DEFAULT_RETRY_ON,
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  MAX_RETRY_COUNT,
  StatusCode,
} from "@/lib/fetcher/consts";
import {
  AbortError,
  HTTPError,
  NetworkError,
  ParseError,
  ResponseTooLargeError,
  TimeoutError,
} from "@/lib/fetcher/errors";
import { FetcherOptions } from "@/lib/fetcher/types";
import { isAbortError } from "@/lib/fetcher/utils";

// The body is consumed as a small pipeline of single-responsibility async
// generators, so the orchestration reads top-to-bottom and the only mutable
// state left lives — isolated — inside the stage that needs it:
//
//   readBytes ─▶ monitor ─▶ decode ─▶ toLines ─▶ parseLine
//   (raw bytes) (size+idle) (text)   (whole lines) (items)

/** Iterate a byte stream via a reader (works in every runtime, unlike
 * `for await` over a ReadableStream), normalizing a mid-stream failure to
 * NetworkError so it is classified like a dropped connection (and resumable). */
async function* readBytes(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (isAbortError(error)) throw error; // let the mapper classify abort/timeout
        throw new NetworkError("Stream interrupted", error);
      }
      if (result.done) return;
      yield result.value;
    }
  } finally {
    // Consumer stopped early or we errored: tear the connection down.
    await reader.cancel().catch(() => {});
  }
}

/** Pass bytes through untouched while enforcing the size cap and resetting the
 * idle timeout on every chunk (so an active stream stays alive). */
async function* monitor(
  chunks: AsyncIterable<Uint8Array>,
  onChunk: () => void,
): AsyncGenerator<Uint8Array> {
  let total = 0;
  for await (const chunk of chunks) {
    onChunk();
    total += chunk.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      throw new ResponseTooLargeError(MAX_RESPONSE_BYTES);
    }
    yield chunk;
  }
}

/** Decode byte chunks into text chunks, flushing any trailing partial
 * multi-byte character at the end. */
async function* decode(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  for await (const chunk of chunks) {
    yield decoder.decode(chunk, { stream: true });
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

/** Reassemble text chunks into complete, newline-terminated lines, carrying the
 * unfinished tail across chunks. */
async function* toLines(
  texts: AsyncIterable<string>,
): AsyncGenerator<string> {
  let buffer = "";
  for await (const text of texts) {
    buffer += text;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield line;
    }
  }
  const last = buffer.trim();
  if (last) yield last;
}

function parseLine<T>(line: string): T {
  try {
    return JSON.parse(line) as T;
  } catch (error) {
    throw new ParseError("Failed to parse NDJSON line", error);
  }
}

/**
 * Stream a newline-delimited JSON (NDJSON) response, yielding one parsed item
 * per line as it arrives instead of buffering the whole body.
 *
 * Shares the request lifecycle with `fetcher`: external-signal linking and the
 * same error mapping (`mapRequestError`). The timeout is an *idle* timeout,
 * re-armed on every chunk, so a long but active stream is not killed while a
 * stalled one still aborts.
 */
export async function* streamNdjson<T>(
  url: string,
  options: FetcherOptions = {},
): AsyncGenerator<T> {
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

  // One mutable handle for the idle timer: re-armed on activity, cleared on exit.
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => controller.abort("timeout"), timeout);
  };

  try {
    arm();
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new HTTPError(
        response.status as StatusCode,
        response.statusText,
        null,
      );
    }
    if (!response.body) return;

    const lines = toLines(decode(monitor(readBytes(response.body), arm)));
    for await (const line of lines) yield parseLine<T>(line);
  } catch (error) {
    throw mapRequestError(error, controller.signal.reason, timeout);
  } finally {
    clearTimeout(timeoutId);
    fetchOptions.signal?.removeEventListener("abort", onAbort);
  }
}

/** Whether a streaming failure is worth transparently resuming from a cursor. */
export function isResumable(error: unknown): boolean {
  if (error instanceof NetworkError || error instanceof TimeoutError)
    return true;
  if (error instanceof HTTPError) return DEFAULT_RETRY_ON.includes(error.status);
  return false;
}

export interface ResumeOptions extends FetcherOptions {
  /** Max reconnects before giving up and rethrowing the failure. */
  maxResumes?: number;
}

/**
 * Drive `streamNdjson` with cursor-based resume. On a resumable mid-stream
 * failure it reconnects from the last successfully-yielded item's cursor
 * (`buildUrl(cursor)` turns it into e.g. `?after=<cursor>`) and keeps going, so
 * the consumer sees one continuous, de-duplicated stream. A non-resumable error
 * (abort, 4xx, parse) or exceeding `maxResumes` rethrows.
 *
 * Requires the server to honor the cursor (return only items strictly after it);
 * otherwise resumed items would duplicate.
 */
export async function* streamWithResume<T>(
  buildUrl: (cursor: string | null) => string,
  getCursor: (item: T) => string,
  options: ResumeOptions = {},
): AsyncGenerator<T> {
  const { maxResumes = MAX_RETRY_COUNT, ...fetchOptions } = options;
  let cursor: string | null = null;
  let resumes = 0;

  while (true) {
    try {
      for await (const item of streamNdjson<T>(buildUrl(cursor), fetchOptions)) {
        cursor = getCursor(item);
        yield item;
      }
      return;
    } catch (error) {
      if (
        fetchOptions.signal?.aborted ||
        resumes >= maxResumes ||
        !isResumable(error)
      ) {
        throw error;
      }
      resumes += 1;
    }
  }
}
