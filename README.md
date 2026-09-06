# nervous-fetch

A reference implementation of fetch for Next.js App Router, covering both Server Components and Client Components. Demonstrates type-safe error handling patterns, NDJSON streaming, and SWR integration for client-side data fetching.

## Features

- **Typed error classification** — Errors are explicitly categorized as `TimeoutError`, `AbortError`, `NetworkError`, `HTTPError`, `ParseError`, `ResponseTooLargeError`, or `UnknownFetchError`, enabling exhaustive handling at the call site
- **Timeout control** — Timeout implemented via `AbortController`, composable with externally provided `AbortSignal`
- **Abort race condition handling** — Checks abort state both before and after `addEventListener` to avoid a race between signal registration and an already-aborted signal
- **Response parsing** — Automatically detects JSON vs. plain text via `Content-Type` (`application/json` plus the `+json` suffix family, so RFC 7807 `application/problem+json` error bodies parse too). Handles 204 / 304 correctly
- **Response-size cap (buffered path)** — Responses larger than `MAX_RESPONSE_BYTES` (10 MiB) are rejected with `ResponseTooLargeError`, checked against `Content-Length` up front and then counted in **bytes** as chunks arrive, so an oversized body is dropped mid-read rather than measured after it is already in memory
- **Line-size cap (streaming path)** — `streamNdjson` puts no limit on the total length of a stream (that is the point of streaming); it bounds a *single line* instead, since the line buffer is the only thing that accumulates. An upstream that never sends a newline is cut off at `MAX_RESPONSE_BYTES`
- **NDJSON streaming** — `streamNdjson` yields one parsed item per line as it arrives instead of buffering the whole body; `streamWithResume` adds cursor-based reconnect that resumes from the last item after a retryable mid-stream failure, backing off (jittered, `resumeBaseDelayMs`) before a reconnect that made no progress
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

The `useFetcher` hook wraps SWR with the shared fetcher and a retry policy: it only retries errors classified as retryable by `isRetryable` — a transient transport failure (`NetworkError`, `TimeoutError`) or a status listed in `retryOn` — up to `MAX_RETRY_COUNT`, using exponential backoff with equal jitter to avoid a thundering herd. Anything else, including `UnknownFetchError`, is not replayed.

**Retry-After.** When the upstream answers 429 or 503 with a `Retry-After` header — either `Retry-After: 120` or an HTTP-date — `HTTPError.retryAfterMs` carries it, and `planRetry` honors it: it waits at least that long, never *shorter* than its own backoff, and re-jitters on top (an HTTP-date is an absolute instant, so clients honoring it verbatim would all return in the same millisecond). A wait longer than `MAX_RETRY_DELAY_MS` gives up instead of holding the request open. `toErrorResponse` relays the header, so a browser client behind an API route is paced by the origin rather than guessing.

**Retries and idempotency.** `isRetryable` takes an optional `method` and returns `false` for non-idempotent ones (`POST`, `PATCH`): a timeout or a dropped connection cannot tell you whether the server already applied the write, so replaying it risks a duplicate record. Both retry drivers (`useFetcher` and `streamWithResume`) pass the method through, and there is deliberately no option to switch the guard off: this fetcher talks to arbitrary backends, so it cannot know whether a given endpoint deduplicates writes. If you have an endpoint that does — one that honors an `Idempotency-Key` you send via `headers` — the decision to retry it belongs at that call site, which knows the endpoint, not in this layer.

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
