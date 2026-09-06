import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isAbortError,
  isJsonContentType,
  isMethodIdempotent,
  isRetryable,
  planRetry,
  toErrorResponse,
} from "@/lib/fetcher/utils";
import {
  AbortError,
  HTTPError,
  NetworkError,
  ParseError,
  ResponseTooLargeError,
  TimeoutError,
  UnknownFetchError,
  parseRetryAfter,
} from "@/lib/fetcher/errors";
import { STATUS_CODE } from "@/lib/fetcher/consts";

describe("isAbortError", () => {
  it("returns true for DOMException with name AbortError", () => {
    const e = new DOMException("aborted", "AbortError");
    expect(isAbortError(e)).toBe(true);
  });

  it("returns false for DOMException with other name", () => {
    const e = new DOMException("quota exceeded", "QuotaExceededError");
    expect(isAbortError(e)).toBe(false);
  });

  it("returns true for Error with name AbortError", () => {
    const e = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(isAbortError(e)).toBe(true);
  });

  it("returns false for an error that only mentions 'aborted' in its message", () => {
    // An upstream failure whose text happens to contain the word must stay
    // retryable — classifying it as a cancel would silently drop it.
    const e = new Error("upstream transaction aborted");
    expect(isAbortError(e)).toBe(false);
  });

  it("returns false for unrelated error", () => {
    expect(isAbortError(new Error("network failure"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("string")).toBe(false);
  });
});

describe("isRetryable", () => {
  const retryOn = [408, 429, 500, 502, 503, 504];

  it("returns false for AbortError", () => {
    expect(isRetryable(new AbortError(), retryOn)).toBe(false);
  });

  it("returns false for ParseError", () => {
    expect(isRetryable(new ParseError("bad json"), retryOn)).toBe(false);
  });

  it("returns true for HTTPError with retryable status", () => {
    expect(isRetryable(new HTTPError(500, "Internal Server Error", null), retryOn)).toBe(true);
    expect(isRetryable(new HTTPError(503, "Service Unavailable", null), retryOn)).toBe(true);
  });

  it("returns false for HTTPError with non-retryable status", () => {
    expect(isRetryable(new HTTPError(404, "Not Found", null), retryOn)).toBe(false);
    expect(isRetryable(new HTTPError(400, "Bad Request", null), retryOn)).toBe(false);
  });

  it("returns true for NetworkError", () => {
    expect(isRetryable(new NetworkError("network failure"), retryOn)).toBe(true);
  });

  it("returns true for TimeoutError", () => {
    expect(isRetryable(new TimeoutError(1000), retryOn)).toBe(true);
  });

  it("returns false for ResponseTooLargeError", () => {
    expect(isRetryable(new ResponseTooLargeError(1000), retryOn)).toBe(false);
  });

  it("returns false for UnknownFetchError", () => {
    // An error we did not anticipate is not assumed safe to replay.
    expect(isRetryable(new UnknownFetchError("???"), retryOn)).toBe(false);
  });

  it("returns false for a non-idempotent method even on a retryable error", () => {
    const e = new HTTPError(503, "Service Unavailable", null);
    expect(isRetryable(e, retryOn, "POST")).toBe(false);
    expect(isRetryable(e, retryOn, "patch")).toBe(false);
    expect(isRetryable(new NetworkError("dropped"), retryOn, "POST")).toBe(
      false,
    );
  });

  it("still retries idempotent methods, and defaults to retrying when no method is given", () => {
    const e = new HTTPError(503, "Service Unavailable", null);
    expect(isRetryable(e, retryOn, "GET")).toBe(true);
    expect(isRetryable(e, retryOn, "delete")).toBe(true);
    expect(isRetryable(e, retryOn)).toBe(true);
  });
});

describe("isMethodIdempotent", () => {
  it("treats POST and PATCH as non-idempotent and the RFC set as idempotent", () => {
    expect(isMethodIdempotent("POST")).toBe(false);
    expect(isMethodIdempotent("PATCH")).toBe(false);
    for (const m of ["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE"]) {
      expect(isMethodIdempotent(m)).toBe(true);
    }
    expect(isMethodIdempotent(undefined)).toBe(true);
  });
});

describe("parseRetryAfter", () => {
  const NOW = Date.parse("2026-01-01T00:00:00Z");

  it("reads the delay-seconds form", () => {
    expect(parseRetryAfter("120", NOW)).toBe(120_000);
    expect(parseRetryAfter("0", NOW)).toBe(0);
    expect(parseRetryAfter("  30  ", NOW)).toBe(30_000);
  });

  it("reads the HTTP-date form, resolved against the current clock", () => {
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:02:00 GMT", NOW)).toBe(120_000);
  });

  it("floors a past date at zero instead of returning a negative wait", () => {
    // Clock skew, or a date the server already passed.
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", NOW + 5000)).toBe(0);
    expect(parseRetryAfter("-30", NOW)).toBe(0);
  });

  it("returns undefined when there is no usable instruction", () => {
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
    expect(parseRetryAfter("", NOW)).toBeUndefined();
    expect(parseRetryAfter("   ", NOW)).toBeUndefined();
    expect(parseRetryAfter("soon", NOW)).toBeUndefined();
  });
});

describe("planRetry", () => {
  const retryOn = [408, 429, 500, 502, 503, 504];
  const opts = { retryOn, baseDelayMs: 1000, maxRetries: 3 };

  it("returns null for a non-retryable error", () => {
    expect(planRetry(new ParseError("bad json"), 1, opts)).toBeNull();
    expect(planRetry(new UnknownFetchError("???"), 1, opts)).toBeNull();
    expect(planRetry(new HTTPError(404, "Not Found", null), 1, opts)).toBeNull();
  });

  it("returns null for a non-idempotent method", () => {
    expect(
      planRetry(new NetworkError("dropped"), 1, { ...opts, method: "POST" }),
    ).toBeNull();
  });

  it("spends exactly maxRetries attempts", () => {
    // attempt is 1-based, so attempts 1..3 are allowed and the 4th is refused.
    const e = new NetworkError("dropped");
    expect(planRetry(e, 1, opts)).not.toBeNull();
    expect(planRetry(e, 3, opts)).not.toBeNull();
    expect(planRetry(e, 4, opts)).toBeNull();
  });

  it("starts the backoff at the base delay and doubles it per attempt", () => {
    // Equal jitter: the delay lands in [window/2, window) for window = base * 2^(n-1).
    const e = new NetworkError("dropped");
    for (const [attempt, low, high] of [
      [1, 500, 1000],
      [2, 1000, 2000],
      [3, 2000, 4000],
    ] as const) {
      for (let i = 0; i < 50; i++) {
        const delay = planRetry(e, attempt, opts)!;
        expect(delay).toBeGreaterThanOrEqual(low);
        expect(delay).toBeLessThan(high);
      }
    }
  });

  it("waits at least as long as the server asked", () => {
    const e = new HTTPError(429, "Too Many Requests", null);
    e.retryAfterMs = 5000;
    for (let i = 0; i < 50; i++) {
      const delay = planRetry(e, 1, opts)!;
      expect(delay).toBeGreaterThanOrEqual(5000);
      expect(delay).toBeLessThanOrEqual(6000); // server delay + up to 20% jitter
    }
  });

  it("never lets Retry-After shorten the backoff below our own", () => {
    // A server that keeps answering "1ms" must not become a retry loop.
    const e = new HTTPError(503, "Service Unavailable", null);
    e.retryAfterMs = 1;
    const delay = planRetry(e, 3, opts)!;
    expect(delay).toBeGreaterThanOrEqual(2000); // attempt 3 → window 4000, half fixed
  });

  it("jitters a server-requested wait, so honoring an absolute date is not a herd", () => {
    // Every client parses the same HTTP-date into the same instant; without
    // jitter they would all come back in the same millisecond.
    const e = new HTTPError(429, "Too Many Requests", null);
    e.retryAfterMs = 5000;
    const delays = new Set(Array.from({ length: 50 }, () => planRetry(e, 1, opts)));
    expect(delays.size).toBeGreaterThan(1);
  });

  it("gives up rather than sit out a wait longer than maxDelayMs", () => {
    const e = new HTTPError(503, "Service Unavailable", null);
    e.retryAfterMs = 86_400_000; // "come back tomorrow"
    expect(planRetry(e, 1, { ...opts, maxDelayMs: 30_000 })).toBeNull();
  });

  it("ignores Retry-After on an error that is not an HTTPError", () => {
    const delay = planRetry(new NetworkError("dropped"), 1, opts)!;
    expect(delay).toBeLessThan(1000);
  });

  it("jitters, so simultaneous clients do not retry in lockstep", () => {
    const e = new NetworkError("dropped");
    const delays = new Set(
      Array.from({ length: 50 }, () => planRetry(e, 1, opts)),
    );
    expect(delays.size).toBeGreaterThan(1);
  });
});

describe("isJsonContentType", () => {
  const withType = (value: string) =>
    new Response("{}", { headers: { "Content-Type": value } });

  it("matches application/json with or without parameters", () => {
    expect(isJsonContentType(withType("application/json"))).toBe(true);
    expect(isJsonContentType(withType("application/json; charset=utf-8"))).toBe(
      true,
    );
    expect(isJsonContentType(withType("APPLICATION/JSON"))).toBe(true);
  });

  it("matches the structured-suffix family", () => {
    // RFC 7807 error bodies arrive as application/problem+json.
    expect(isJsonContentType(withType("application/problem+json"))).toBe(true);
    expect(isJsonContentType(withType("application/vnd.api+json"))).toBe(true);
  });

  it("does not match a type that merely starts with application/json", () => {
    expect(isJsonContentType(withType("application/json5"))).toBe(false);
    expect(isJsonContentType(withType("text/plain"))).toBe(false);
    expect(isJsonContentType(new Response("{}"))).toBe(false);
  });
});

describe("toErrorResponse", () => {
  // The unknown-error branch logs server-side; silence it during tests.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 499 for AbortError", async () => {
    const res = toErrorResponse(new AbortError());
    expect(res.status).toBe(STATUS_CODE.CLIENT_CLOSED_REQUEST);
    const body = await res.json();
    expect(body.error).toBe("Request aborted");
  });

  it("returns 504 for TimeoutError", async () => {
    const res = toErrorResponse(new TimeoutError(5000));
    expect(res.status).toBe(STATUS_CODE.GATEWAY_TIMEOUT);
    const body = await res.json();
    expect(body.error).toContain("5000ms");
  });

  it("returns 502 for NetworkError", async () => {
    const res = toErrorResponse(new NetworkError("connection refused"));
    expect(res.status).toBe(STATUS_CODE.BAD_GATEWAY);
    const body = await res.json();
    expect(body.error).toBe("connection refused");
  });

  it("returns 502 for ParseError", async () => {
    const res = toErrorResponse(new ParseError("invalid json"));
    expect(res.status).toBe(STATUS_CODE.BAD_GATEWAY);
  });

  it("returns 413 for ResponseTooLargeError", async () => {
    const res = toErrorResponse(new ResponseTooLargeError(1000));
    expect(res.status).toBe(STATUS_CODE.PAYLOAD_TOO_LARGE);
    const body = await res.json();
    expect(body.error).toContain("1000-byte limit");
  });

  it("mirrors the HTTP status for HTTPError", async () => {
    const res = toErrorResponse(new HTTPError(422, "Unprocessable Entity", null));
    expect(res.status).toBe(422);
  });

  it("mirrors the HTTP status for a status we never enumerated", async () => {
    // `status` is a number, so an upstream 410/402/451 flows through honestly
    // instead of being cast into the StatusCode union.
    const res = toErrorResponse(new HTTPError(410, "Gone", null));
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body).toEqual({ error: "HTTP 410 Gone", source: "external" });
  });

  it("relays the upstream Retry-After so the client is paced by the origin", async () => {
    const error = new HTTPError(429, "Too Many Requests", null);
    error.retryAfterMs = 4200;
    const res = toErrorResponse(error);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("5"); // ceil, in seconds
  });

  it("omits Retry-After when the upstream did not send one", async () => {
    const res = toErrorResponse(new HTTPError(503, "Service Unavailable", null));
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  it("keeps the status in the message when the reason phrase is empty (HTTP/2)", async () => {
    const res = toErrorResponse(new HTTPError(502, "", null));
    const body = await res.json();
    expect(body.error).toBe("HTTP 502");
  });

  it("returns 500 for UnknownFetchError without leaking the message, keeping source", async () => {
    const res = toErrorResponse(
      new UnknownFetchError("internal db host 10.0.0.5 unreachable"),
      "external",
    );
    expect(res.status).toBe(STATUS_CODE.INTERNAL_SERVER_ERROR);
    const body = await res.json();
    // The raw error.message must not reach the client...
    expect(body.error).toBe("Internal Server Error");
    // ...but the origin (outbound request path) is preserved via `source`.
    expect(body.source).toBe("external");
  });

  it("tags non-fetcher errors as api_route regardless of the source arg", async () => {
    // A plain string isn't a fetcher error, so the route itself is the origin.
    const res = toErrorResponse("plain string error", "external");
    expect(res.status).toBe(STATUS_CODE.INTERNAL_SERVER_ERROR);
    const body = await res.json();
    expect(body.error).toBe("Internal Server Error");
    expect(body.source).toBe("api_route");
  });
});
