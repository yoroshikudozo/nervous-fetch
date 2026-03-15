import { fetcher } from "@/lib/fetcher";
import { useFetcher } from "@/lib/fetcher/hooks";

type Post = { id: number; title: string };

const EXTERNAL_URL = "https://external-api.com/posts";
const INTERNAL_URL = "/api/posts";

export const fetchPosts = () => fetcher<Post[]>(EXTERNAL_URL);

export const usePosts = () => useFetcher<Post[]>(INTERNAL_URL);
