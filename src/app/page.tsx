import { Posts } from "@/components/Posts";
import { MswProvider } from "@/mocks/MswProvider";
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
      <MswProvider>
        <Posts />
      </MswProvider>
    </>
  );
}
