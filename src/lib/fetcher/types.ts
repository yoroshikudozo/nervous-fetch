export interface FetcherOptions extends RequestInit {
  timeout?: number;
}

export type FetcherBody = Record<string, unknown> | FormData;

export interface MutationOptions extends Omit<
  FetcherOptions,
  "body" | "method"
> {
  body?: FetcherBody;
}
