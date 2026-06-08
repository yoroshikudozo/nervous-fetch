import { describe, it, expect, vi, afterEach } from "vitest";
import { fetcher, buildMutationOptions } from "@/lib/fetcher/core";
import {
  AbortError,
  HTTPError,
  NetworkError,
  ParseError,
  ResponseTooLargeError,
  TimeoutError,
} from "@/lib/fetcher/errors";
import { MAX_RESPONSE_BYTES } from "@/lib/fetcher/consts";

function makeResponse(
  body: unknown,
  options: { status?: number; contentType?: string } = {},
): Response {
  const { status = 200, contentType = "application/json" } = options;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "Content-Type": contentType } });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("fetcher", () => {
  it("returns parsed JSON on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse({ id: 1 })));
    const result = await fetcher<{ id: number }>("/api/test");
    expect(result).toEqual({ id: 1 });
  });

  it("returns plain text when content-type is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeResponse("hello", { contentType: "text/plain" })),
    );
    const result = await fetcher<string>("/api/text");
    expect(result).toBe("hello");
  });

  it("returns null for 204 No Content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
    const result = await fetcher<null>("/api/empty");
    expect(result).toBeNull();
  });

  it("throws HTTPError on 4xx response", async () => {
    // Each call needs a fresh Response because body can only be read once
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(makeResponse({ error: "not found" }, { status: 404 })),
      ),
    );
    await expect(fetcher("/api/missing")).rejects.toThrow(HTTPError);
    await expect(fetcher("/api/missing")).rejects.toMatchObject({ status: 404 });
  });

  it("throws HTTPError with arbitrary status codes not in StatusCode union", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(makeResponse({ error: "gone" }, { status: 410 })),
      ),
    );
    await expect(fetcher("/api/gone")).rejects.toMatchObject({ status: 410 });
  });

  it("throws TimeoutError when request exceeds timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
      ),
    );
    const promise = fetcher("/api/slow", { timeout: 50 });
    promise.catch(() => {}); // prevent unhandled rejection before handler is attached
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).rejects.toThrow(TimeoutError);
  });

  it("throws AbortError when external signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      fetcher("/api/test", { signal: controller.signal }),
    ).rejects.toThrow(AbortError);
  });

  it("throws NetworkError on TypeError from fetch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(fetcher("/api/test")).rejects.toThrow(NetworkError);
  });

  it("throws ResponseTooLargeError when content-length exceeds the limit", async () => {
    // Body is tiny, but the declared content-length is huge: reject up-front.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("{}", {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(MAX_RESPONSE_BYTES + 1),
          },
        }),
      ),
    );
    await expect(fetcher("/api/huge")).rejects.toThrow(ResponseTooLargeError);
  });

  it("throws ResponseTooLargeError when the read body exceeds the limit", async () => {
    // No content-length (chunked); caught by the post-read size check.
    const huge = "x".repeat(MAX_RESPONSE_BYTES + 1);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(huge, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      ),
    );
    await expect(fetcher("/api/huge-chunked")).rejects.toThrow(
      ResponseTooLargeError,
    );
  });

  it("throws ParseError on invalid JSON with application/json content-type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("not-json{", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await expect(fetcher("/api/bad-json")).rejects.toThrow(ParseError);
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
