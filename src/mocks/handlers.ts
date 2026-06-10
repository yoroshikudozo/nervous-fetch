import { http, HttpResponse } from "msw";
import { db } from "./db";

// Shared between node (tests) and browser (dev demo). The `*` prefix matches
// both relative (browser) and absolute (node) request URLs.
export const handlers = [
  // Internal API consumed by the client (usePosts) and the mutations.
  http.get("*/api/posts", () => HttpResponse.json(db.list())),

  // Streaming variant: emits posts as NDJSON (one line per post) and honors an
  // `?after=<id>` cursor so a client can resume from where a broken stream left.
  http.get("*/api/posts/stream", ({ request }) => {
    const after = Number(new URL(request.url).searchParams.get("after") ?? "0");
    const items = db.list().filter((post) => post.id > after);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const item of items) {
          controller.enqueue(encoder.encode(`${JSON.stringify(item)}\n`));
        }
        controller.close();
      },
    });
    return new HttpResponse(stream, {
      headers: { "Content-Type": "application/x-ndjson" },
    });
  }),

  http.post("*/api/posts", async ({ request }) => {
    const body = (await request.json()) as { title: string };
    return HttpResponse.json(db.create(body), { status: 201 });
  }),

  http.patch("*/api/posts/:id", async ({ request, params }) => {
    const body = (await request.json()) as { title: string };
    const updated = db.update(Number(params.id), body);
    if (!updated) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json(updated);
  }),

  http.delete("*/api/posts/:id", ({ params }) => {
    const removed = db.remove(Number(params.id));
    return new HttpResponse(null, { status: removed ? 204 : 404 });
  }),

  // External API used by the server-side fetchPosts(); mocked so tests stay
  // deterministic and don't depend on the public placeholder API being up.
  http.get("https://jsonplaceholder.typicode.com/posts", () =>
    HttpResponse.json(db.list()),
  ),
];
