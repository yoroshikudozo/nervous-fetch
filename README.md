# nervous-fetch

A reference implementation of fetch for Next.js App Router, covering both Server Components and Client Components. Demonstrates type-safe error handling patterns, NDJSON streaming, and SWR integration for client-side data fetching.

## Features

- **Typed error classification** — Errors are explicitly categorized as `TimeoutError`, `AbortError`, `NetworkError`, `HTTPError`, `ParseError`, `ResponseTooLargeError`, or `UnknownFetchError`, enabling exhaustive handling at the call site
- **Timeout control** — Timeout implemented via `AbortController`, composable with externally provided `AbortSignal`
- **Abort race condition handling** — Checks abort state both before and after `addEventListener` to avoid a race between signal registration and an already-aborted signal
- **Response parsing** — Automatically detects JSON vs. plain text via `Content-Type`. Handles 204 / 304 correctly
- **Response-size cap** — Responses larger than `MAX_RESPONSE_BYTES` (10 MB) are rejected with `ResponseTooLargeError`, checked against `Content-Length` up front and the actual bytes after reading
- **NDJSON streaming** — `streamNdjson` yields one parsed item per line as it arrives instead of buffering the whole body; `streamWithResume` adds cursor-based reconnect that resumes from the last item after a retryable mid-stream failure
- **SWR integration** — The `useFetcher` hook wires the fetcher into SWR with a retryable-error policy and exponential backoff + equal jitter

## Directory Structure

```
src/
└── lib/
    └── fetcher/
        ├── index.ts      # Barrel re-export of the modules below
        ├── core.ts       # fetcher / buildMutationOptions / mapRequestError / linkAbortSignal
        ├── stream.ts     # streamNdjson / streamWithResume (NDJSON streaming)
        ├── hooks.ts      # useFetcher (SWR + retry/backoff)
        ├── errors.ts     # Custom error classes
        ├── types.ts      # FetcherOptions / MutationOptions
        ├── consts.ts     # DEFAULT_TIMEOUT_MS / MAX_RESPONSE_BYTES / StatusCode
        └── utils.ts      # isAbortError / isRetryable, etc.
```

## Error Hierarchy

All error classes extend the built-in `Error`.

```
Error
├── TimeoutError          — Request exceeded the timeout duration
├── AbortError            — Request was cancelled externally
├── NetworkError          — Network unreachable or stream interrupted
├── HTTPError             — 4xx / 5xx response received
├── ParseError            — Failed to parse response as JSON
├── ResponseTooLargeError — Response exceeded the size cap (MAX_RESPONSE_BYTES)
└── UnknownFetchError     — Unexpected error not matching any of the above
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

### Streaming NDJSON

```ts
import { streamNdjson, streamWithResume } from "@/lib/fetcher";

// One parsed item per line, yielded as it arrives
for await (const event of streamNdjson<Event>("/api/events")) {
  console.log(event);
}

// Resumable: reconnects from the last item's cursor on a retryable mid-stream drop
const stream = streamWithResume<Event>(
  (cursor) => (cursor ? `/api/events?after=${cursor}` : "/api/events"),
  (event) => event.id,
);
for await (const event of stream) {
  console.log(event);
}
```

The timeout applies to connection setup and then to each individual read (network inactivity), not to how long the consumer spends processing each item. `streamWithResume` requires the server to honor the cursor — i.e. return only items strictly after it — otherwise resumed items would duplicate.

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

The `useFetcher` hook wraps SWR with the shared fetcher and a retry policy: it only retries errors classified as retryable by `isRetryable` (e.g. network errors and configured status codes), up to `MAX_RETRY_COUNT`, using exponential backoff with equal jitter to avoid a thundering herd.

```ts
"use client";

import { useFetcher } from "@/lib/fetcher";

export function UserProfile({ id }: { id: string }) {
  const { data, error } = useFetcher<User>(`/api/users/${id}`);

  if (error) return <div>Error</div>;
  if (!data) return <div>Loading...</div>;
  return <div>{data.name}</div>;
}
```

`useFetcher` also accepts `retryOn` (status codes to retry) and an `swr` object for the underlying `SWRConfiguration`. To opt out of the retry policy, use SWR directly with the raw `fetcher`:

```ts
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";

const { data, error } = useSWR<User>(`/api/users/${id}`, fetcher);
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
