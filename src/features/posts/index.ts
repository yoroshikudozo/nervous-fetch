import { buildMutationOptions, fetcher } from "@/lib/fetcher";
import { useFetcher } from "@/lib/fetcher/hooks";

type Post = { id: number; title: string };
type CreatePostInput = { title: string };
type UpdatePostInput = { id: number; title: string };

// Defaults to a public placeholder API so the demo actually returns posts;
// override with EXTERNAL_BASE_URL to point at a real backend.
const EXTERNAL_BASE_URL =
  process.env.EXTERNAL_BASE_URL ?? "https://jsonplaceholder.typicode.com";
// "" in the browser keeps the relative "/api/posts"; node tests set an
// absolute origin (INTERNAL_BASE_URL) so real fetch can resolve the URL.
const INTERNAL_BASE_URL = process.env.INTERNAL_BASE_URL ?? "";
const INTERNAL_POSTS_URL = `${INTERNAL_BASE_URL}/api/posts`;

// Server-side "staleTime": cache the external list, but treat it as stale after
// REVALIDATE_SECONDS so Next refreshes it in the background. Tagged "posts" so a
// mutation can evict it on demand (memory + disk) via revalidateTag("posts").
const REVALIDATE_SECONDS = 60;

export const fetchPosts = () =>
  fetcher<Post[]>(`${EXTERNAL_BASE_URL}/posts`, {
    next: { revalidate: REVALIDATE_SECONDS, tags: ["posts"] },
  });

export const createPost = (body: CreatePostInput) =>
  fetcher<Post>(INTERNAL_POSTS_URL, buildMutationOptions("POST", { body }));

export const updatePost = (id: number, body: UpdatePostInput) =>
  fetcher<Post>(
    `${INTERNAL_POSTS_URL}/${id}`,
    buildMutationOptions("PATCH", { body }),
  );

export const deletePost = (id: number) =>
  fetcher<void>(
    `${INTERNAL_POSTS_URL}/${id}`,
    buildMutationOptions("DELETE", {}),
  );

export const usePosts = () => useFetcher<Post[]>(INTERNAL_POSTS_URL);
