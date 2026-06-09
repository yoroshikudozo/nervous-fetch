"use client";

import { useEffect, useState, type ReactNode } from "react";

// Starts the MSW browser worker in development so the demo's mutations hit the
// in-memory store. The worker is imported dynamically so msw is never loaded in
// production, where this renders its children immediately.
export function MswProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(process.env.NODE_ENV === "production");

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    let active = true;
    import("@/mocks/browser").then(async ({ worker }) => {
      await worker.start({ onUnhandledRequest: "bypass" });
      if (active) setReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!ready) return null;
  return <>{children}</>;
}
