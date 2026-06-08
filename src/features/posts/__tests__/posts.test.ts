import { describe, it, expect } from "vitest";
import {
  createPost,
  updatePost,
  deletePost,
  fetchPosts,
} from "@/features/posts";
import { fetcher } from "@/lib/fetcher";

type Post = { id: number; title: string };

// The MSW in-memory store is reset between tests (src/test/setup.ts), so each
// case starts from the same seed.
const listInternal = () =>
  fetcher<Post[]>("http://localhost/api/posts");

describe("posts mutations (msw-backed)", () => {
  it("createPost adds a post that shows up in the list", async () => {
    const created = await createPost({ title: "hello" });
    expect(created).toMatchObject({ title: "hello" });
    expect(typeof created.id).toBe("number");

    const list = await listInternal();
    expect(list.some((p) => p.id === created.id && p.title === "hello")).toBe(
      true,
    );
  });

  it("updatePost changes the title", async () => {
    const created = await createPost({ title: "before" });
    const updated = await updatePost(created.id, {
      id: created.id,
      title: "after",
    });
    expect(updated.title).toBe("after");

    const list = await listInternal();
    expect(list.find((p) => p.id === created.id)?.title).toBe("after");
  });

  it("deletePost removes the post", async () => {
    const created = await createPost({ title: "doomed" });
    await deletePost(created.id);

    const list = await listInternal();
    expect(list.some((p) => p.id === created.id)).toBe(false);
  });

  it("fetchPosts reads the external API through msw", async () => {
    const posts = await fetchPosts();
    expect(Array.isArray(posts)).toBe(true);
    expect(posts.length).toBeGreaterThan(0);
  });
});
