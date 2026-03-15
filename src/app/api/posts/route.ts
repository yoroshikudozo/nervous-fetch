import { fetchPosts } from "@/features/posts";
import { withErrorHandling } from "@/lib/fetcher";

export const GET = withErrorHandling(async () => {
  const data = await fetchPosts();
  return Response.json(data);
});
