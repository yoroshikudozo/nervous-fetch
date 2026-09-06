"use client";

import useSWR, { type SWRConfiguration } from "swr";
import { fetcher, planRetry, FetcherOptions } from "@/lib/fetcher";
import { DEFAULT_RETRY_ON } from "@/lib/fetcher";

interface UseFetcherOptions<T> extends FetcherOptions {
  retryOn?: number[];
  swr?: SWRConfiguration<T>;
}

export function useFetcher<T>(url: string, options: UseFetcherOptions<T> = {}) {
  const {
    retryOn = DEFAULT_RETRY_ON,
    swr: swrOptions,
    ...fetcherOptions
  } = options;

  return useSWR<T>(url, (url) => fetcher<T>(url, fetcherOptions), {
    // SWR increments before calling us, so `retryCount` is 1-based. The policy
    // itself lives in planRetry.
    onErrorRetry: (error, _key, _config, revalidate, { retryCount }) => {
      const delay = planRetry(error, retryCount, {
        retryOn,
        // Guards a caller who wires this to something other than a GET.
        method: fetcherOptions.method,
      });
      if (delay === null) return;
      // `dedupe: true` mirrors SWR's own retry path: without it, every hook
      // sharing this key fires its own retry request.
      setTimeout(() => revalidate({ retryCount, dedupe: true }), delay);
    },
    ...swrOptions,
  });
}
