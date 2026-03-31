import { buildMutationOptions, fetcher } from "@/lib/fetcher";
import { useFetcher } from "@/lib/fetcher/hooks";

type Post = { id: number; title: string };
type CreatePostInput = { title: string };
type UpdatePostInput = { id: number; title: string };

const EXTERNAL_POSTS_URL = "https://external-api.com/posts";
const INTERNAL_POSTS_URL = "/api/posts";

export const fetchPosts = () => fetcher<Post[]>(EXTERNAL_POSTS_URL);

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
