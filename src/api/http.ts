// The one place the plugin talks to Circleback. Everything goes through `requestUrl` with
// `throw: false`, so status codes and headers can be read, and gets:
// - a timeout per request (`requestUrl` has none, and a hung request would hold the sync
//   lock forever),
// - throttling: calls are spaced 3 seconds apart (the free plan's 20 a minute) until a
//   response shows the account's real limit, and after that the plugin waits whenever
//   `RateLimit-Remaining` reaches 0,
// - retries of a 429 after the time `Retry-After` gives.
//
// The limit is shared with the account's other devices and tools, so a 429 can still happen
// and is handled. Waits longer than two minutes are never slept: the call fails with
// `rate-limited` and the next sync tries again, so a hostile or broken header cannot park
// the sync for hours.
import { requestUrl as obsidianRequestUrl } from "obsidian";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { logger } from "../util/logger";
import { API_BASE, AUTH_ERROR_STATUSES, SITE_ORIGIN } from "./constants";
import { CirclebackError } from "./errors";

/** The part of a `requestUrl` response this wrapper reads. */
export type HttpResponse = Pick<RequestUrlResponse, "status" | "headers" | "text">;

export interface HttpDeps {
  /** Defaults to Obsidian's `requestUrl`. */
  requestUrl?: (request: RequestUrlParam) => Promise<HttpResponse>;
  /** Defaults to a real wait. Tests replace it with one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds on any steady clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Per request. Defaults to 60,000. */
  timeoutMs?: number;
  /**
   * The timer functions behind the timeout and the default `sleep`. They default to
   * `window.setTimeout` and `window.clearTimeout`, which the Obsidian review lint requires
   * and which Jest's Node environment does not have, so tests pass their own.
   */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const DEFAULT_TIMEOUT_MS = 60_000;
/** 20 requests a minute, the free plan's limit. */
const MIN_SPACING_MS = 3_000;
const MAX_RATE_LIMIT_RETRIES = 3;
/**
 * Used when a 429 (or `RateLimit-Remaining: 0`) gives no time to wait. Longer than the 3
 * second spacing of the free plan, short enough not to stall a sync for long.
 */
const FALLBACK_WAIT_SECONDS = 5;
const MAX_WAIT_MS = 120_000;
const MAX_REASON_LENGTH = 200;
const KEY_PATTERN = /cb_[A-Za-z0-9_-]+/g;
/**
 * A key that is not shaped like a key (text pasted along with it, say) gets 400 with
 * `{"error":"The provided token is invalid."}`, not the 401 that a well-formed wrong key gets.
 */
const MALFORMED_KEY_STATUS = 400;
/** Real keys are far longer. A shorter string would mangle messages that merely contain it. */
const MIN_REDACTED_KEY_LENGTH = 8;

/** Reads a response header whatever its case. */
export function getHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

/** Whether the API's own explanation of a 400 says the token or API key is invalid. */
function saysKeyIsInvalid(reason: string | undefined): boolean {
  return reason !== undefined && /token|api key/i.test(reason) && /invalid/i.test(reason);
}

/** A non-negative number of seconds, or undefined if the header is missing or not one. */
function parseSeconds(value: string | undefined): number | undefined {
  const text = value?.trim();
  if (text === undefined || !/^\d+(\.\d+)?$/.test(text)) return undefined;
  return Number(text);
}

function toMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

/** `RateLimit-Limit` as a request count, tolerating trailing policy text like "300, 300;w=60". */
function parseLimit(value: string | undefined): number | undefined {
  const match = /^\s*(\d+)/.exec(value ?? "");
  const limit = match ? Number(match[1]) : 0;
  return limit > 0 ? limit : undefined;
}

export class HttpClient {
  /**
   * The latest `RateLimit-Limit`. Circleback limits each account per second and per minute
   * (3 and 20 on the free plan) and reports whichever window is closer to running out, so
   * the value moves between the two. Undefined until a response carries the header. A caller
   * that knows the value from an earlier run may set it to skip the call spacing.
   */
  rateLimit: number | undefined;

  readonly #key: string;
  readonly #requestUrl: (request: RequestUrlParam) => Promise<HttpResponse>;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #setTimer: (callback: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;

  /** When the latest request started. */
  #lastStart: number | undefined;
  /** No call may start before this time: the rate limit window has not reset yet. */
  #blockedUntil = 0;
  /** Chains callers so concurrent calls take their turns one by one. */
  #turn: Promise<void> = Promise.resolve();

  constructor(key: string, deps: HttpDeps = {}) {
    this.#key = key;
    this.#requestUrl = deps.requestUrl ?? obsidianRequestUrl;
    this.#now = deps.now ?? (() => Date.now());
    this.#timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#setTimer = deps.setTimer ?? ((callback, ms) => window.setTimeout(callback, ms));
    this.#clearTimer = deps.clearTimer ?? ((handle) => window.clearTimeout(handle as number));
    this.#sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => void this.#setTimer(resolve, ms)));
  }

  /**
   * GETs a JSON document. `pathOrUrl` is a path under the API base (`/meetings`) or an
   * absolute `https://circleback.ai/...` URL such as a next-page link, which is used as is.
   * `query` is an already serialized query string. The returned headers are as received,
   * so read them with `getHeader`.
   */
  async getJson(pathOrUrl: string, query?: string): Promise<{ body: unknown; headers: Record<string, string> }> {
    const url = this.#buildUrl(pathOrUrl, query);
    await this.#waitForTurn();
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.#send(url);
      logger.debug(`GET ${url} -> ${response.status}`);
      this.#recordRateHeaders(response.headers);
      if (response.status !== 429) return this.#toResult(response);

      if (attempt >= MAX_RATE_LIMIT_RETRIES) {
        throw new CirclebackError(
          "rate-limited",
          `Circleback is still rate limiting this key after ${MAX_RATE_LIMIT_RETRIES} retries.`,
          429,
        );
      }
      const waitMs = this.#retryDelayMs(response.headers);
      if (waitMs > MAX_WAIT_MS) {
        throw new CirclebackError(
          "rate-limited",
          `Circleback is rate limiting this key and asked to wait ${Math.ceil(waitMs / 1000)} seconds.`,
          429,
        );
      }
      logger.info(`Rate limited by Circleback; retrying in ${waitMs} ms (retry ${attempt + 1} of ${MAX_RATE_LIMIT_RETRIES}).`);
      // The server named the time, so this wait replaces the usual call spacing.
      await this.#sleep(waitMs);
      this.#lastStart = this.#now();
    }
  }

  #buildUrl(pathOrUrl: string, query: string | undefined): string {
    let url: string;
    if (/^[a-z][a-z0-9+.-]*:/i.test(pathOrUrl)) {
      // The key goes wherever the URL points, and next-page links come from a response.
      // Only the real site may receive it.
      let origin: string;
      let host: string;
      try {
        const parsed = new URL(pathOrUrl);
        origin = parsed.origin;
        host = parsed.host;
      } catch {
        origin = "";
        host = "an address that cannot be read";
      }
      if (origin !== SITE_ORIGIN) {
        throw new CirclebackError("invalid-response", `Refusing to send the API key to ${host}; only ${SITE_ORIGIN} is allowed.`);
      }
      url = pathOrUrl;
    } else {
      url = pathOrUrl.startsWith("/") ? API_BASE + pathOrUrl : `${API_BASE}/${pathOrUrl}`;
    }
    const extra = (query ?? "").replace(/^[?&]+/, "");
    if (extra === "") return url;
    return url + (url.includes("?") ? "&" : "?") + extra;
  }

  /**
   * Waits until a new call may start, then records its start. Callers go through one at a
   * time, so concurrent calls cannot all see an empty schedule.
   */
  async #waitForTurn(): Promise<void> {
    const previous = this.#turn;
    let done: () => void = () => undefined;
    this.#turn = new Promise<void>((resolve) => {
      done = resolve;
    });
    await previous;
    try {
      const now = this.#now();
      const blockedMs = this.#blockedUntil - now;
      if (blockedMs > MAX_WAIT_MS) {
        throw new CirclebackError(
          "rate-limited",
          `Circleback's rate limit resets in ${Math.ceil(blockedMs / 1000)} seconds, which is too long to wait.`,
          429,
        );
      }
      let waitMs = Math.max(0, blockedMs);
      if (this.rateLimit === undefined && this.#lastStart !== undefined) {
        waitMs = Math.max(waitMs, this.#lastStart + MIN_SPACING_MS - now);
      }
      if (waitMs > 0) {
        logger.debug(`Waiting ${waitMs} ms before the next Circleback call.`);
        await this.#sleep(waitMs);
      }
      this.#lastStart = this.#now();
    } finally {
      done();
    }
  }

  /** One request, raced against the timeout. The timer is always cleared. */
  async #send(url: string): Promise<HttpResponse> {
    let timer: unknown;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = this.#setTimer(() => {
        reject(new CirclebackError("timeout", `Circleback did not respond within ${this.#timeoutMs / 1000} seconds.`));
      }, this.#timeoutMs);
    });
    try {
      return await Promise.race([this.#call(url), timedOut]);
    } catch (error) {
      if (error instanceof CirclebackError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new CirclebackError("network", `Could not reach Circleback: ${this.#redact(reason)}`);
    } finally {
      this.#clearTimer(timer);
    }
  }

  // Async so that a request function that throws instead of rejecting is still caught.
  async #call(url: string): Promise<HttpResponse> {
    return this.#requestUrl({ url, headers: { Authorization: `Bearer ${this.#key}` }, throw: false });
  }

  /**
   * Learns the limit, and when it is used up, when it resets. `RateLimit-Reset` is the
   * number of seconds until the reported window ends.
   */
  #recordRateHeaders(headers: Record<string, string>): void {
    const limit = parseLimit(getHeader(headers, "RateLimit-Limit"));
    if (limit !== undefined) this.rateLimit = limit;

    const remaining = parseSeconds(getHeader(headers, "RateLimit-Remaining"));
    if (remaining === undefined) return;
    if (remaining > 0) {
      this.#blockedUntil = 0;
      return;
    }
    const resetSeconds = parseSeconds(getHeader(headers, "RateLimit-Reset")) ?? FALLBACK_WAIT_SECONDS;
    this.#blockedUntil = this.#now() + toMs(resetSeconds);
  }

  #retryDelayMs(headers: Record<string, string>): number {
    const seconds =
      parseSeconds(getHeader(headers, "Retry-After")) ??
      parseSeconds(getHeader(headers, "RateLimit-Reset")) ??
      FALLBACK_WAIT_SECONDS;
    return toMs(seconds);
  }

  #toResult(response: HttpResponse): { body: unknown; headers: Record<string, string> } {
    const { status, headers } = response;
    if (status >= 200 && status < 300) {
      try {
        return { body: JSON.parse(response.text) as unknown, headers };
      } catch {
        throw new CirclebackError("invalid-response", `Circleback sent a response that is not valid JSON (HTTP ${status}).`, status);
      }
    }
    if (this.#rejectsKey(response)) {
      throw new CirclebackError("auth", `Circleback rejected the API key (HTTP ${status}). Check the key in the plugin settings.`, status);
    }
    if (status === 403) {
      throw new CirclebackError("forbidden", "Circleback says this key may not view that item (HTTP 403).", 403);
    }
    if (status >= 500) {
      throw new CirclebackError("server", `Circleback had a server error (HTTP ${status}).`, status);
    }
    const reason = this.#reasonFrom(response.text);
    throw new CirclebackError(
      "invalid-response",
      `Circleback sent an unexpected response (HTTP ${status})${reason ? `: ${reason}` : "."}`,
      status,
    );
  }

  /** Whether a failed response says the key was not accepted: a 401, or the 400 that a malformed key gets. */
  #rejectsKey({ status, text }: HttpResponse): boolean {
    if (AUTH_ERROR_STATUSES.includes(status)) return true;
    return status === MALFORMED_KEY_STATUS && saysKeyIsInvalid(this.#reasonFrom(text));
  }

  /** The API's own explanation (`{ "error": "..." }`) from an error body, if there is one. */
  #reasonFrom(text: string): string | undefined {
    try {
      const body = JSON.parse(text) as { error?: unknown } | null;
      if (typeof body?.error !== "string" || body.error === "") return undefined;
      return this.#redact(body.error.slice(0, MAX_REASON_LENGTH));
    } catch {
      return undefined;
    }
  }

  /** Keeps the API key out of any text that reaches an error message. */
  #redact(text: string): string {
    let clean = text.replace(KEY_PATTERN, "[redacted]");
    if (this.#key.length >= MIN_REDACTED_KEY_LENGTH) clean = clean.split(this.#key).join("[redacted]");
    return clean;
  }
}
