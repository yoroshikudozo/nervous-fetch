import { describe, it, expect, vi, afterEach } from "vitest";
import { http, HttpResponse, delay } from "msw";
import { server } from "@/mocks/server";
import {
  fetcher,
  buildMutationOptions,
  mapRequestError,
} from "@/lib/fetcher/core";
import {
  AbortError,
  HTTPError,
  NetworkError,
  ParseError,
  ResponseTooLargeError,
  TimeoutError,
} from "@/lib/fetcher/errors";
import { MAX_RESPONSE_BYTES } from "@/lib/fetcher/consts";

// Node fetch needs absolute URLs; MSW (started in src/test/setup.ts) intercepts.
const BASE = "http://localhost";

afterEach(() => {
  vi.useRealTimers();
});

describe("fetcher", () => {
  it("returns parsed JSON on success", async () => {
    server.use(
      http.get(`${BASE}/api/test`, () => HttpResponse.json({ id: 1 })),
    );
    const result = await fetcher<{ id: number }>(`${BASE}/api/test`);
    expect(result).toEqual({ id: 1 });
  });

  it("returns plain text when content-type is not JSON", async () => {
    server.use(
      http.get(
        `${BASE}/api/text`,
        () =>
          new HttpResponse("hello", {
            headers: { "Content-Type": "text/plain" },
          }),
      ),
    );
    const result = await fetcher<string>(`${BASE}/api/text`);
    expect(result).toBe("hello");
  });

  it("returns null for 204 No Content", async () => {
    server.use(
      http.get(
        `${BASE}/api/empty`,
        () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const result = await fetcher<null>(`${BASE}/api/empty`);
    expect(result).toBeNull();
  });

  it("throws HTTPError on 4xx response", async () => {
    server.use(
      http.get(`${BASE}/api/missing`, () =>
        HttpResponse.json({ error: "not found" }, { status: 404 }),
      ),
    );
    await expect(fetcher(`${BASE}/api/missing`)).rejects.toThrow(HTTPError);
    await expect(fetcher(`${BASE}/api/missing`)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("throws HTTPError with arbitrary status codes not in StatusCode union", async () => {
    server.use(
      http.get(`${BASE}/api/gone`, () =>
        HttpResponse.json({ error: "gone" }, { status: 410 }),
      ),
    );
    await expect(fetcher(`${BASE}/api/gone`)).rejects.toMatchObject({
      status: 410,
    });
  });

  it("throws TimeoutError when request exceeds timeout", async () => {
    vi.useFakeTimers();
    // `delay("infinite")` never resolves; the fetcher's own timeout aborts it.
    server.use(
      http.get(`${BASE}/api/slow`, async () => {
        await delay("infinite");
        return HttpResponse.json({});
      }),
    );
    const promise = fetcher(`${BASE}/api/slow`, { timeout: 50 });
    promise.catch(() => {}); // prevent unhandled rejection before handler is attached
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).rejects.toThrow(TimeoutError);
  });

  it("throws AbortError when external signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    // The fetcher throws before calling fetch, so no handler is needed.
    await expect(
      fetcher(`${BASE}/api/test`, { signal: controller.signal }),
    ).rejects.toThrow(AbortError);
  });

  it("throws NetworkError on a network failure", async () => {
    server.use(http.get(`${BASE}/api/down`, () => HttpResponse.error()));
    await expect(fetcher(`${BASE}/api/down`)).rejects.toThrow(NetworkError);
  });

  it("captures Retry-After from the failing response", async () => {
    server.use(
      http.get(
        `${BASE}/api/limited`,
        () =>
          new HttpResponse(null, {
            status: 429,
            headers: { "Retry-After": "42" },
          }),
      ),
    );
    // The Response is gone by the time the retry policy runs, so the header has
    // to be read at throw time.
    await expect(fetcher(`${BASE}/api/limited`)).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 42_000,
    });
  });

  it("leaves retryAfterMs undefined when the server sent no instruction", async () => {
    server.use(
      http.get(
        `${BASE}/api/limited-silent`,
        () => new HttpResponse(null, { status: 429 }),
      ),
    );
    await expect(fetcher(`${BASE}/api/limited-silent`)).rejects.toMatchObject({
      status: 429,
      retryAfterMs: undefined,
    });
  });

  it("throws ResponseTooLargeError when content-length exceeds the limit", async () => {
    // Body is tiny, but the declared content-length is huge: reject up-front.
    server.use(
      http.get(
        `${BASE}/api/huge`,
        () =>
          new HttpResponse("{}", {
            headers: {
              "Content-Type": "application/json",
              "Content-Length": String(MAX_RESPONSE_BYTES + 1),
            },
          }),
      ),
    );
    await expect(fetcher(`${BASE}/api/huge`)).rejects.toThrow(
      ResponseTooLargeError,
    );
  });

  it("throws ResponseTooLargeError when the read body exceeds the limit", async () => {
    // No content-length (chunked); caught while reading, by byte count.
    const huge = "x".repeat(MAX_RESPONSE_BYTES + 1);
    server.use(
      http.get(
        `${BASE}/api/huge-chunked`,
        () =>
          new HttpResponse(huge, {
            headers: { "Content-Type": "text/plain" },
          }),
      ),
    );
    await expect(fetcher(`${BASE}/api/huge-chunked`)).rejects.toThrow(
      ResponseTooLargeError,
    );
  });

  it("counts the cap in bytes, not UTF-16 code units", async () => {
    // 3.5M Japanese characters: ~3.5M code units (under the cap if you measure
    // `text.length`) but ~10.5MB once UTF-8 encoded (over it).
    const multibyte = "\u3042".repeat(3_500_000);
    expect(multibyte.length).toBeLessThan(MAX_RESPONSE_BYTES);
    expect(new TextEncoder().encode(multibyte).byteLength).toBeGreaterThan(
      MAX_RESPONSE_BYTES,
    );
    server.use(
      http.get(
        `${BASE}/api/huge-multibyte`,
        () =>
          new HttpResponse(multibyte, {
            headers: { "Content-Type": "text/plain" },
          }),
      ),
    );
    await expect(fetcher(`${BASE}/api/huge-multibyte`)).rejects.toThrow(
      ResponseTooLargeError,
    );
  });

  it("throws ParseError on invalid JSON with application/json content-type", async () => {
    server.use(
      http.get(
        `${BASE}/api/bad-json`,
        () =>
          new HttpResponse("not-json{", {
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    await expect(fetcher(`${BASE}/api/bad-json`)).rejects.toThrow(ParseError);
  });
});

describe("buildMutationOptions", () => {
  it("sets method and JSON headers for plain object body", () => {
    const opts = buildMutationOptions("POST", { body: { name: "test" } });
    expect(opts.method).toBe("POST");
    expect(new Headers(opts.headers).get("Content-Type")).toBe(
      "application/json",
    );
    expect(opts.body).toBe(JSON.stringify({ name: "test" }));
  });

  it("does not set Content-Type header for FormData body", () => {
    const form = new FormData();
    form.append("key", "value");
    const opts = buildMutationOptions("POST", { body: form });
    expect(opts.body).toBe(form);
    expect(opts.headers).toBeUndefined();
  });

  it("sets body to undefined when no body provided", () => {
    const opts = buildMutationOptions("DELETE", {});
    expect(opts.body).toBeUndefined();
  });

  it("keeps headers passed as a Headers instance", () => {
    // Spreading a Headers instance yields {} — the header would vanish silently.
    const opts = buildMutationOptions("POST", {
      body: { name: "test" },
      headers: new Headers({ Authorization: "Bearer token" }),
    });
    const headers = new Headers(opts.headers);
    expect(headers.get("Authorization")).toBe("Bearer token");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("keeps headers passed as a [key, value][]", () => {
    const opts = buildMutationOptions("POST", {
      body: { name: "test" },
      headers: [["X-Request-Id", "abc"]],
    });
    const headers = new Headers(opts.headers);
    expect(headers.get("X-Request-Id")).toBe("abc");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("lets an explicit Content-Type win", () => {
    const opts = buildMutationOptions("POST", {
      body: { name: "test" },
      headers: { "Content-Type": "application/merge-patch+json" },
    });
    expect(new Headers(opts.headers).get("Content-Type")).toBe(
      "application/merge-patch+json",
    );
  });
});

describe("mapRequestError", () => {
  it("maps an 'external' reason to AbortError, outranking the error type", () => {
    // A caller cancel must win even when the timeout overwrote the abort reason
    // and the surfaced error looks like something else (e.g. a network failure).
    const result = mapRequestError(new TypeError("boom"), "external", 1000);
    expect(result).toBeInstanceOf(AbortError);
  });

  it("maps a 'timeout' reason to TimeoutError", () => {
    const result = mapRequestError(new Error("boom"), "timeout", 1000);
    expect(result).toBeInstanceOf(TimeoutError);
  });
});
