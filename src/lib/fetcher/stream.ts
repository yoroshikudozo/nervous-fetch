import { linkAbortSignal, mapRequestError } from "@/lib/fetcher/core";
import {
  DEFAULT_RETRY_ON,
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  MAX_RETRY_COUNT,
  RETRY_BASE_DELAY_MS,
} from "@/lib/fetcher/consts";
import {
  HTTPError,
  NetworkError,
  ParseError,
  ResponseTooLargeError,
} from "@/lib/fetcher/errors";
import { FetcherOptions } from "@/lib/fetcher/types";
import { isAbortError, isRetryable, planRetry } from "@/lib/fetcher/utils";

// The body is consumed as a small pipeline of single-responsibility async
// generators, so the orchestration reads top-to-bottom and the only mutable
// state left lives — isolated — inside the stage that needs it:
//
//   readBytes ─▶ guardLines ─▶ decode ─▶ toLines ─▶ parseLine
//   (read+time) (line cap)   (text)    (whole lines) (items)

/** Iterate a byte stream via a reader (works in every runtime, unlike
 * `for await` over a ReadableStream), normalizing a mid-stream failure to
 * NetworkError so it is classified like a dropped connection (and resumable).
 *
 * The idle timeout is armed around each `reader.read()` and cleared the instant
 * data arrives — so it measures network inactivity only, not how long the
 * consumer spends processing the chunk we yield (which must not count). */
async function* readBytes(
  stream: ReadableStream<Uint8Array>,
  controller: AbortController,
  timeout: number,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const timer = setTimeout(() => controller.abort("timeout"), timeout);
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (isAbortError(error)) throw error; // let the mapper classify abort/timeout
        throw new NetworkError("Stream interrupted", error);
      } finally {
        clearTimeout(timer); // stop timing before the (untimed) consumer work
      }
      if (result.done) return;
      yield result.value;
    }
  } finally {
    // Consumer stopped early or we errored: tear the connection down. Not
    // awaited — cancel() waits on the peer, so a dead connection would hang the
    // caller's `break` out of the loop.
    void reader.cancel().catch(() => {});
  }
}

/** Pass bytes through untouched while bounding the length of a single line.
 *
 * Total stream length is deliberately *not* capped — outgrowing memory is the
 * case this API exists for. What can grow without bound is toLines' buffer,
 * which accumulates until a newline arrives, so that is what we bound.
 *
 * Measured on raw bytes: a UTF-8 newline is always the single byte 0x0A and
 * never occurs inside a multi-byte character, so scanning here is exact, needs
 * no decoding, and counts bytes — which is what a memory limit means. */
async function* guardLines(
  chunks: AsyncIterable<Uint8Array>,
  maxLineBytes: number,
): AsyncGenerator<Uint8Array> {
  const tooLong = () =>
    new ResponseTooLargeError(maxLineBytes, undefined, "A single line");
  let pending = 0; // bytes seen since the last newline

  for await (const chunk of chunks) {
    let start = 0;
    let newline: number;
    while ((newline = chunk.indexOf(0x0a, start)) !== -1) {
      pending += newline - start;
      if (pending > maxLineBytes) throw tooLong();
      pending = 0;
      start = newline + 1;
    }
    pending += chunk.byteLength - start;
    if (pending > maxLineBytes) throw tooLong();
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
    // Walk a cursor over the buffer and drop the consumed prefix once per chunk,
    // instead of reallocating the whole buffer on every newline.
    let start = 0;
    let newline: number;
    while ((newline = buffer.indexOf("\n", start)) !== -1) {
      const line = buffer.slice(start, newline).trim();
      start = newline + 1;
      if (line) yield line;
    }
    if (start > 0) buffer = buffer.slice(start);
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
 * Shares the request lifecycle with `fetcher` (linkAbortSignal + mapRequestError).
 * The timeout covers connection setup and then each individual read (see
 * readBytes), so it reflects network inactivity rather than consumer speed.
 */
export async function* streamNdjson<T>(
  url: string,
  options: FetcherOptions = {},
): AsyncGenerator<T> {
  const { timeout = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;
  const { controller, cleanup, getReason } = linkAbortSignal(fetchOptions.signal);
  // Timeout for connecting; once streaming, each read is timed in readBytes.
  const connectTimer = setTimeout(() => controller.abort("timeout"), timeout);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    clearTimeout(connectTimer);

    // 204/304 are body-less successful completions (matches the buffered parseResponse).
    if (response.status === 204 || response.status === 304) return;
    if (!response.ok) {
      throw HTTPError.fromResponse(
        response,
        await response.text().catch(() => null),
      );
    }
    if (!response.body) return;

    const lines = toLines(
      decode(
        guardLines(
          readBytes(response.body, controller, timeout),
          MAX_RESPONSE_BYTES,
        ),
      ),
    );
    for await (const line of lines) yield parseLine<T>(line);
  } catch (error) {
    throw mapRequestError(error, getReason(), timeout);
  } finally {
    clearTimeout(connectTimer);
    cleanup();
  }
}

export interface ResumeOptions extends FetcherOptions {
  /** Max *consecutive* no-progress reconnects before giving up and rethrowing. */
  maxResumes?: number;
  /** Base backoff before a no-progress reconnect (doubles per consecutive failure). */
  resumeBaseDelayMs?: number;
}

/** Wait `ms`, resolving early if the caller cancels, so a pending backoff never
 * outlives an abort. */
function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish);
  });
}

/**
 * Drive `streamNdjson` with cursor-based resume. On a retryable mid-stream
 * failure it reconnects from the last successfully-yielded item's cursor
 * (`buildUrl(cursor)` turns it into e.g. `?after=<cursor>`) and keeps going, so
 * the consumer sees one continuous, de-duplicated stream. A non-retryable error
 * (abort, 4xx, parse) rethrows; the same `isRetryable` policy is used as the
 * buffered SWR path. `maxResumes` bounds *consecutive* failed reconnects — any
 * forward progress refreshes the budget, so a long flaky-but-advancing stream
 * is not truncated.
 *
 * Requires the server to honor the cursor (return only items strictly after it);
 * otherwise resumed items would duplicate.
 */
export async function* streamWithResume<T>(
  buildUrl: (cursor: string | null) => string,
  getCursor: (item: T) => string,
  options: ResumeOptions = {},
): AsyncGenerator<T> {
  const {
    maxResumes = MAX_RETRY_COUNT,
    resumeBaseDelayMs = RETRY_BASE_DELAY_MS,
    ...fetchOptions
  } = options;
  let cursor: string | null = null;
  let resumes = 0;

  while (true) {
    let progressed = false;
    try {
      for await (const item of streamNdjson<T>(buildUrl(cursor), fetchOptions)) {
        cursor = getCursor(item);
        progressed = true;
        yield item;
      }
      return;
    } catch (error) {
      if (
        fetchOptions.signal?.aborted ||
        !(error instanceof Error) ||
        !isRetryable(error, DEFAULT_RETRY_ON, fetchOptions.method)
      ) {
        throw error;
      }
      // The stream was advancing, so there is nothing to back off from.
      if (progressed) {
        resumes = 0;
        continue;
      }
      // Only zero-progress reconnects spend the budget — and they wait first, so
      // a server that is down isn't hit by a tight reconnect loop.
      const delay = planRetry(error, ++resumes, {
        retryOn: DEFAULT_RETRY_ON,
        method: fetchOptions.method,
        maxRetries: maxResumes,
        baseDelayMs: resumeBaseDelayMs,
      });
      if (delay === null) throw error;
      await wait(delay, fetchOptions.signal);
    }
  }
}
