// Starts the MSW node server in development so server-side fetches (e.g. the
// Server Component's fetchPosts) go through the same handlers as the browser
// worker, keeping the SSR list consistent with the in-memory store. Imported
// dynamically and guarded, so msw never loads in production or on the edge.
export async function register() {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.NEXT_RUNTIME === "nodejs"
  ) {
    const { server } = await import("@/mocks/server");
    server.listen({ onUnhandledRequest: "bypass" });
  }
}
