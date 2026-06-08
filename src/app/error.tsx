"use client";

import { useEffect } from "react";

// Error boundary for the route segment. Without this, a throw from the
// Server Component's `await fetchPosts()` surfaces as a bare 500 page.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log client-side; never render the raw message (it may leak internals).
    console.error(error);
  }, [error]);

  return (
    <div>
      <p>記事の取得に失敗しました。</p>
      <button onClick={() => reset()}>再試行</button>
    </div>
  );
}
