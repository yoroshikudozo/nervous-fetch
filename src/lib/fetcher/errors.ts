/**
 * Parse a `Retry-After` header into milliseconds from now. Both forms occur:
 * delay-seconds (`120`) and an HTTP-date (`Wed, 21 Oct 2015 07:28:00 GMT`,
 * typical of 503). A past date, or clock skew, floors at 0 rather than going
 * negative. Undefined means "no instruction" — not "retry now".
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed); // NaN for a date, so this ordering is safe
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export class HTTPError extends Error {
  /** Whatever the upstream returned (402, 451, ...), not the StatusCode union:
   * narrowing it to the codes we happen to have named would be a lie the
   * compiler then propagates into "exhaustive" switches. */
  status: number;
  statusText: string;
  body: unknown;
  /** `Retry-After` in ms, when the server sent one. Only `fromResponse` fills
   * this in — a hand-built HTTPError has no headers to read. */
  retryAfterMs?: number;

  /** Build from the failing response, which is the last place `Retry-After` can
   * be read: an HTTPError keeps a snapshot, deliberately not the Response (that
   * would pin its body stream and connection), so no headers survive the throw. */
  static fromResponse(
    response: Response,
    body: unknown,
    cause?: unknown,
  ): HTTPError {
    const error = new HTTPError(
      response.status,
      response.statusText,
      body,
      cause,
    );
    error.retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    return error;
  }

  constructor(
    status: number,
    statusText: string,
    body: unknown,
    cause?: unknown,
  ) {
    // HTTP/2 and /3 have no reason phrase, so `statusText` is "" on most modern
    // responses — keep the code in the message so logs still say something.
    super(statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`, {
      cause,
    });
    this.name = "HTTPError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

export class NetworkError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "NetworkError";
  }
}

export class TimeoutError extends Error {
  constructor(ms: number, cause?: unknown) {
    super(`Request timed out after ${ms}ms`, { cause });
    this.name = "TimeoutError";
  }
}

export class AbortError extends Error {
  constructor(cause?: unknown) {
    super("Request aborted", { cause });
    this.name = "AbortError";
  }
}

export class ParseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ParseError";
  }
}

export class ResponseTooLargeError extends Error {
  // `subject` differs by path: the buffered one caps a whole body, the streaming
  // one a single line.
  constructor(maxBytes: number, cause?: unknown, subject = "Response body") {
    super(`${subject} exceeds the ${maxBytes}-byte limit`, { cause });
    this.name = "ResponseTooLargeError";
  }
}

export class UnknownFetchError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "UnknownFetchError";
  }
}
