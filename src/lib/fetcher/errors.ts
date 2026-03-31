import { StatusCode } from "@/lib/fetcher/consts";

export class HTTPError extends Error {
  status: StatusCode;
  body: unknown;
  constructor(
    status: StatusCode,
    statusText: string,
    body: unknown,
    cause?: unknown,
  ) {
    super(statusText, { cause });
    this.name = "HTTPError";
    this.status = status;
    this.body = body;
  }
}

export class NetworkError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "NetworkError";
  }
}

export class TimeoutError extends Error {
  constructor(ms: number, cause?: unknown) {
    super(`Request timed out after ${ms}ms`, { cause });
    this.name = "TimeoutError";
  }
}

export class AbortError extends Error {
  constructor(cause?: unknown) {
    super("Request aborted", { cause });
    this.name = "AbortError";
  }
}

export class ParseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ParseError";
  }
}

export class UnknownFetchError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "UnknownFetchError";
  }
}
