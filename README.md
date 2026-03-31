# nervous-fetch

A reference implementation of fetch for Next.js App Router, covering both Server Components and Client Components. Demonstrates type-safe error handling patterns and SWR integration for client-side data fetching.

## Features

- **Typed error classification** — Errors are explicitly categorized as `TimeoutError`, `AbortError`, `NetworkError`, `HTTPError`, `ParseError`, or `UnknownFetchError`, enabling exhaustive handling at the call site
- **Timeout control** — Timeout implemented via `AbortController`, composable with externally provided `AbortSignal`
- **Abort race condition handling** — Checks abort state both before and after `addEventListener` to avoid a race between signal registration and an already-aborted signal
- **Response parsing** — Automatically detects JSON vs. plain text via `Content-Type`. Handles 204 / 304 correctly
- **SWR integration** — Example pattern for combining the fetcher with SWR hooks in Client Components

## Directory Structure

```
src/
└── lib/
    └── fetcher/
        ├── index.ts      # fetcher / buildMutationOptions
        ├── errors.ts     # Custom error classes
        ├── types.ts      # FetcherOptions / MutationOptions
        ├── consts.ts     # DEFAULT_TIMEOUT_MS / StatusCode
        └── utils.ts      # isAbortError, etc.
```

## Error Hierarchy

```
FetcherError (base)
├── TimeoutError       — Request exceeded the timeout duration
├── AbortError         — Request was cancelled externally
├── NetworkError       — Network unreachable or stream interrupted
├── HTTPError          — 4xx / 5xx response received
├── ParseError         — Failed to parse response as JSON
└── UnknownFetchError  — Unexpected error not matching any of the above
```

## Usage

### Basic GET

```ts
import { fetcher } from "@/lib/fetcher";

const data = await fetcher<User>("/api/users/1");
```

### Custom timeout

```ts
const data = await fetcher<User>("/api/users/1", { timeout: 5000 });
```

### With AbortSignal

```ts
const controller = new AbortController();
const data = await fetcher<User>("/api/users/1", { signal: controller.signal });

// Cancel the request
controller.abort();
```

### Mutations (POST / PUT / DELETE)

```ts
import { fetcher, buildMutationOptions } from "@/lib/fetcher";

const data = await fetcher<User>(
  "/api/users",
  buildMutationOptions("POST", { body: { name: "Alice" } }),
);
```

When `body` is `FormData`, `Content-Type` is not set manually — the browser sets it automatically. Otherwise, `application/json` is applied.

### Error handling

```ts
import {
  AbortError,
  HTTPError,
  NetworkError,
  TimeoutError,
} from "@/lib/fetcher/errors";

try {
  const data = await fetcher<User>("/api/users/1");
} catch (error) {
  if (error instanceof TimeoutError) {
    console.error(`Timed out after ${error.timeout}ms`);
  } else if (error instanceof AbortError) {
    // Cancelled — typically safe to ignore
  } else if (error instanceof HTTPError) {
    console.error(`HTTP ${error.status}: ${error.statusText}`);
  } else if (error instanceof NetworkError) {
    console.error("Network unreachable");
  }
}
```

### SWR integration (Client Component)

```ts
"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";

export function UserProfile({ id }: { id: string }) {
  const { data, error } = useSWR<User>(`/api/users/${id}`, fetcher);

  if (error) return <div>Error</div>;
  if (!data) return <div>Loading...</div>;
  return <div>{data.name}</div>;
}
```

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Tech Stack

- [Next.js](https://nextjs.org/) (App Router)
- [SWR](https://swr.vercel.app/)
- TypeScript
