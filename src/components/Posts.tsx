"use client";

import { useState, type FormEvent } from "react";
import { HTTPError } from "@/lib/fetcher";
import { usePosts, createPost, deletePost } from "@/features/posts";

export function Posts() {
  const { data, error, mutate } = usePosts();
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);

  if (error instanceof HTTPError) return <p>HTTP Error: {error.status}</p>;
  if (error) return <p>エラーが発生しました</p>;
  if (!data) return <p>Loading...</p>;

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    setPending(true);
    try {
      await createPost({ title: trimmed });
      setTitle("");
      await mutate();
    } finally {
      setPending(false);
    }
  };

  const handleDelete = async (id: number) => {
    await deletePost(id);
    await mutate();
  };

  return (
    <div>
      <form onSubmit={handleCreate}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New post title"
        />
        <button type="submit" disabled={pending}>
          Add
        </button>
      </form>
      <ul>
        {data.map((post) => (
          <li key={post.id}>
            {post.title}
            <button type="button" onClick={() => handleDelete(post.id)}>
              削除
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
