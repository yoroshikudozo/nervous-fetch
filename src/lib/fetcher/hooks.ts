"use client";

import useSWR, { type SWRConfiguration } from "swr";
import { fetcher, isRetryable, FetcherOptions } from "@/lib/fetcher";
import {
  RETRY_BASE_DELAY_MS,
  MAX_RETRY_COUNT,
  DEFAULT_RETRY_ON,
} from "@/lib/fetcher";

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
    onErrorRetry: (error, _key, _config, revalidate, { retryCount }) => {
      if (!isRetryable(error, retryOn)) return;
      if (retryCount >= MAX_RETRY_COUNT) return;
      // Exponential backoff with equal jitter, so many clients failing at the
      // same moment don't retry in lockstep and hammer the server (thundering
      // herd). Each retry waits half the backoff plus a random half.
      const backoff = RETRY_BASE_DELAY_MS * 2 ** retryCount;
      const delay = backoff / 2 + Math.random() * (backoff / 2);
      setTimeout(() => revalidate({ retryCount }), delay);
    },
    ...swrOptions,
  });
}
