import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isAbortError,
  isRetryable,
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

  it("returns true for Error with 'aborted' in message", () => {
    const e = new Error("The operation was aborted");
    expect(isAbortError(e)).toBe(true);
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

  it("returns false for ResponseTooLargeError", () => {
    expect(isRetryable(new ResponseTooLargeError(1000), retryOn)).toBe(false);
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

  it("mirrors the HTTP status for HTTPError with status not in StatusCode union", async () => {
    // @ts-expect-error: 410 is not assignable to StatusCode — TypeScript catches this at compile time
    const res = toErrorResponse(new HTTPError(410, "Gone", null));
    // runtime: `as StatusCode` in core.ts is a cast-only — the actual value flows through as-is
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body).toEqual({ error: "Gone", source: "external" });
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
