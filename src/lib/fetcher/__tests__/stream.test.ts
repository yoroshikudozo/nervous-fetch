import { describe, it, expect } from "vitest";
import { http, HttpResponse, delay } from "msw";
import { server } from "@/mocks/server";
import { streamNdjson, streamWithResume } from "@/lib/fetcher/stream";
import {
  AbortError,
  HTTPError,
  NetworkError,
  ParseError,
  ResponseTooLargeError,
} from "@/lib/fetcher/errors";

// Node fetch needs absolute URLs; MSW (started in src/test/setup.ts) intercepts.
const BASE = "http://localhost";

type Item = { id: number };

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

// Build an NDJSON streaming response from a raw body string.
function ndjson(body: string) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new HttpResponse(stream, {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

describe("streamNdjson", () => {
  it("yields one parsed item per line", async () => {
    server.use(
      http.get(`${BASE}/stream`, () =>
        ndjson(`{"id":1}\n{"id":2}\n{"id":3}\n`),
      ),
    );
    const items = await collect(streamNdjson<Item>(`${BASE}/stream`));
    expect(items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("flushes a trailing line that has no newline", async () => {
    server.use(
      http.get(`${BASE}/stream`, () => ndjson(`{"id":1}\n{"id":2}`)),
    );
    const items = await collect(streamNdjson<Item>(`${BASE}/stream`));
    expect(items).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("throws ParseError on a malformed line", async () => {
    server.use(
      http.get(`${BASE}/stream`, () => ndjson(`{"id":1}\nnot-json\n`)),
    );
    await expect(collect(streamNdjson<Item>(`${BASE}/stream`))).rejects.toThrow(
      ParseError,
    );
  });

  it("throws HTTPError on a non-ok response", async () => {
    server.use(
      http.get(`${BASE}/stream`, () => new HttpResponse(null, { status: 404 })),
    );
    await expect(collect(streamNdjson<Item>(`${BASE}/stream`))).rejects.toThrow(
      HTTPError,
    );
  });

  it("throws AbortError when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      collect(streamNdjson<Item>(`${BASE}/stream`, { signal: ac.signal })),
    ).rejects.toThrow(AbortError);
  });

  it("does not time out when the consumer is slow between items", async () => {
    // Bytes arrive fast; the CONSUMER is slow. The timeout must measure network
    // idleness, not consumer latency — with a per-pull timer this would abort.
    server.use(
      http.get(`${BASE}/stream`, () =>
        ndjson(`{"id":1}\n{"id":2}\n{"id":3}\n`),
      ),
    );
    const out: Item[] = [];
    for await (const item of streamNdjson<Item>(`${BASE}/stream`, {
      timeout: 50,
    })) {
      await delay(120); // slower than the 50ms timeout, on every item
      out.push(item);
    }
    expect(out.map((i) => i.id)).toEqual([1, 2, 3]);
  });
});

describe("streamNdjson size limits", () => {
  const MiB = 1024 * 1024;

  const streamOf = (chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });

  it("does not cap the total length of the stream", async () => {
    // Well past MAX_RESPONSE_BYTES in total, but every line is small: streaming
    // exists precisely for bodies that do not fit in memory.
    const filler = "x".repeat(MiB);
    const lines = Array.from(
      { length: 12 },
      (_, i) => `${JSON.stringify({ id: i + 1, filler })}\n`,
    );
    server.use(
      http.get(
        `${BASE}/stream`,
        () =>
          new HttpResponse(streamOf(lines), {
            headers: { "Content-Type": "application/x-ndjson" },
          }),
      ),
    );

    const ids: number[] = [];
    for await (const item of streamNdjson<Item>(`${BASE}/stream`)) {
      ids.push(item.id);
    }
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("rejects a single line that never terminates", async () => {
    // No newline anywhere: toLines' buffer would grow until the process dies.
    const chunks = Array.from({ length: 11 }, () => "x".repeat(MiB));
    server.use(
      http.get(
        `${BASE}/stream`,
        () =>
          new HttpResponse(streamOf(chunks), {
            headers: { "Content-Type": "application/x-ndjson" },
          }),
      ),
    );

    await expect(
      collect(streamNdjson<Item>(`${BASE}/stream`)),
    ).rejects.toThrow(ResponseTooLargeError);
  });

  it("counts each line separately, not cumulatively", async () => {
    // Two lines that are individually fine but together exceed the limit.
    const half = "x".repeat(6 * MiB);
    server.use(
      http.get(
        `${BASE}/stream`,
        () =>
          new HttpResponse(
            streamOf([
              `${JSON.stringify({ id: 1, half })}\n`,
              `${JSON.stringify({ id: 2, half })}\n`,
            ]),
            { headers: { "Content-Type": "application/x-ndjson" } },
          ),
      ),
    );

    const items = await collect(streamNdjson<Item>(`${BASE}/stream`));
    expect(items.map((i) => i.id)).toEqual([1, 2]);
  });
});

describe("streamWithResume", () => {
  const buildUrl = (cursor: string | null) =>
    `${BASE}/stream${cursor ? `?after=${cursor}` : ""}`;
  const getCursor = (item: Item) => String(item.id);

  it("resumes from the cursor after a mid-stream failure", async () => {
    let attempt = 0;
    server.use(
      http.get(`${BASE}/stream`, ({ request }) => {
        attempt += 1;
        const after = Number(
          new URL(request.url).searchParams.get("after") ?? "0",
        );
        const items = [{ id: 1 }, { id: 2 }, { id: 3 }].filter(
          (p) => p.id > after,
        );
        const failFirst = attempt === 1;
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            let sent = 0;
            for (const item of items) {
              // First connection drops after a single item to force a resume.
              if (failFirst && sent >= 1) {
                controller.error(new Error("connection dropped"));
                return;
              }
              controller.enqueue(encoder.encode(`${JSON.stringify(item)}\n`));
              sent += 1;
            }
            controller.close();
          },
        });
        return new HttpResponse(stream, {
          headers: { "Content-Type": "application/x-ndjson" },
        });
      }),
    );

    const items = await collect(
      streamWithResume<Item>(buildUrl, getCursor),
    );

    expect(items.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(attempt).toBe(2); // one failed connection + one resume
  });

  it("does not resume on a non-resumable error (4xx) and rethrows", async () => {
    let attempt = 0;
    server.use(
      http.get(`${BASE}/stream`, () => {
        attempt += 1;
        return new HttpResponse(null, { status: 404 });
      }),
    );
    await expect(
      collect(streamWithResume<Item>(buildUrl, getCursor)),
    ).rejects.toThrow(HTTPError);
    expect(attempt).toBe(1);
  });

  it("refreshes the resume budget on forward progress", async () => {
    let attempt = 0;
    server.use(
      http.get(`${BASE}/stream`, ({ request }) => {
        attempt += 1;
        const after = Number(
          new URL(request.url).searchParams.get("after") ?? "0",
        );
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            // Yield exactly one new item then drop — repeatedly, far more than
            // maxResumes — but every drop follows real progress.
            if (after >= 5) {
              controller.close();
              return;
            }
            controller.enqueue(
              encoder.encode(`${JSON.stringify({ id: after + 1 })}\n`),
            );
            await delay(10); // let the client consume the item before the drop
            controller.error(new Error("connection dropped"));
          },
        });
        return new HttpResponse(stream, {
          headers: { "Content-Type": "application/x-ndjson" },
        });
      }),
    );

    // maxResumes: 1 would kill a lifetime-budget impl after the first drop;
    // progress must refresh it so all 5 items still arrive.
    const items = await collect(
      streamWithResume<Item>(buildUrl, getCursor, {
        maxResumes: 1,
        resumeBaseDelayMs: 1,
      }),
    );
    expect(items.map((i) => i.id)).toEqual([1, 2, 3, 4, 5]);
    expect(attempt).toBe(6); // 5 progressing drops + 1 clean finish
  });

  it("gives up after maxResumes consecutive no-progress failures", async () => {
    let attempt = 0;
    server.use(
      http.get(`${BASE}/stream`, () => {
        attempt += 1;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("connection dropped"));
          },
        });
        return new HttpResponse(stream, {
          headers: { "Content-Type": "application/x-ndjson" },
        });
      }),
    );

    await expect(
      collect(
        streamWithResume<Item>(buildUrl, getCursor, {
          maxResumes: 2,
          resumeBaseDelayMs: 1,
        }),
      ),
    ).rejects.toThrow(NetworkError);
    expect(attempt).toBe(3); // initial + 2 resumes, all zero-progress
  });

  it("backs off before a no-progress reconnect instead of looping tight", async () => {
    let attempt = 0;
    server.use(
      http.get(`${BASE}/stream`, () => {
        attempt += 1;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("connection dropped"));
          },
        });
        return new HttpResponse(stream, {
          headers: { "Content-Type": "application/x-ndjson" },
        });
      }),
    );

    const started = Date.now();
    await expect(
      collect(
        streamWithResume<Item>(buildUrl, getCursor, {
          maxResumes: 2,
          resumeBaseDelayMs: 200,
        }),
      ),
    ).rejects.toThrow(NetworkError);
    // Equal jitter: >= 100 for the first reconnect and >= 200 for the second.
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(attempt).toBe(3);
  });

  it("abandons a pending backoff as soon as the caller aborts", async () => {
    server.use(
      http.get(`${BASE}/stream`, () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("connection dropped"));
          },
        });
        return new HttpResponse(stream, {
          headers: { "Content-Type": "application/x-ndjson" },
        });
      }),
    );

    const controller = new AbortController();
    const started = Date.now();
    const promise = collect(
      streamWithResume<Item>(buildUrl, getCursor, {
        signal: controller.signal,
        // Long enough that finishing on time proves we did not sit out the wait.
        resumeBaseDelayMs: 30_000,
      }),
    );
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
