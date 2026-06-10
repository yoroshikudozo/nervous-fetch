import { describe, it, expect } from "vitest";
import { http, HttpResponse, delay } from "msw";
import { server } from "@/mocks/server";
import { streamNdjson, streamWithResume } from "@/lib/fetcher/stream";
import {
  AbortError,
  HTTPError,
  NetworkError,
  ParseError,
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
      streamWithResume<Item>(buildUrl, getCursor, { maxResumes: 1 }),
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
      collect(streamWithResume<Item>(buildUrl, getCursor, { maxResumes: 2 })),
    ).rejects.toThrow(NetworkError);
    expect(attempt).toBe(3); // initial + 2 resumes, all zero-progress
  });
});
