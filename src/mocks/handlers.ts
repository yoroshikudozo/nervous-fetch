import { http, HttpResponse } from "msw";
import { db } from "./db";

// Shared between node (tests) and browser (dev demo). The `*` prefix matches
// both relative (browser) and absolute (node) request URLs.
export const handlers = [
  // Internal API consumed by the client (usePosts) and the mutations.
  http.get("*/api/posts", () => HttpResponse.json(db.list())),

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
