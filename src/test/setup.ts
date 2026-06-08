import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "@/mocks/server";
import { db } from "@/mocks/db";

// Route all fetches through MSW. Unhandled requests fail loudly so a test
// can't accidentally hit the real network.
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  db.reset();
});
afterAll(() => server.close());
