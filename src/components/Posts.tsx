"use client";

import { HTTPError } from "@/lib/fetcher";
import { usePosts } from "@/features/posts";

export function Posts() {
  const { data, error } = usePosts();

  if (error instanceof HTTPError) return <p>HTTP Error: {error.status}</p>;
  if (error) return <p>エラーが発生しました</p>;
  if (!data) return <p>Loading...</p>;

  return (
    <ul>
      {data.map((post) => (
        <li key={post.id}>{post.title}</li>
      ))}
    </ul>
  );
}
