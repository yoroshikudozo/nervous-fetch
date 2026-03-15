import { Posts } from "@/components/Posts";
import { fetchPosts } from "@/features/posts";

export default async function Home() {
  const posts = await fetchPosts();

  return (
    <>
      <ul>
        {posts.map((post) => (
          <li key={post.id}>{post.title}</li>
        ))}
      </ul>
      <Posts />
    </>
  );
}
