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
    // No content-length (chunked); caught by the post-read size check.
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
    expect((opts.headers as Record<string, string>)["Content-Type"]).toBe(
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
