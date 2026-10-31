import { AUTH_ERROR_STATUSES } from "../../src/api/constants";
import { CirclebackError } from "../../src/api/errors";
import type { CirclebackErrorKind } from "../../src/api/errors";
import { HttpClient, getHeader } from "../../src/api/http";
import type { HttpResponse } from "../../src/api/http";

const KEY = "cb_test_key_0123456789";

// Real timers by default. Tests that need to control time switch Jest to fake timers,
// and these wrappers pick the fake ones up because they look up setTimeout at call time.
const timers = {
  setTimer: (callback: () => void, ms: number): unknown => setTimeout(callback, ms),
  clearTimer: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  text?: string;
}

function reply({ status, headers = {}, body = {}, text }: Reply): HttpResponse {
  return { status, headers, text: text ?? JSON.stringify(body) };
}

// A client wired to a scripted request function and a fake clock. Sleeping advances the
// clock instead of waiting, so "how long did it wait" is exact. Each scripted reply is used
// once; the last one repeats. An Error in the script makes that request throw.
function setup(script: (Reply | Error)[] = [{ status: 200 }], timeoutMs?: number) {
  let clock = 1_000_000;
  let next = 0;
  const sleep = jest.fn(async (ms: number): Promise<void> => {
    clock += ms;
  });
  const requestUrl = jest.fn(async (): Promise<HttpResponse> => {
    const step = script[Math.min(next++, script.length - 1)];
    if (step instanceof Error) throw step;
    return reply(step);
  });
  const client = new HttpClient(KEY, { requestUrl, sleep, now: () => clock, timeoutMs, ...timers });
  return {
    client,
    requestUrl,
    sleep,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<CirclebackError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CirclebackError);
    return error as CirclebackError;
  }
  throw new Error("expected the call to fail");
}

// Headers a paid account's responses carry. With a limit on record, calls are not spaced.
const PAID = { "RateLimit-Limit": "300", "RateLimit-Remaining": "299", "RateLimit-Reset": "60" };

afterEach(() => {
  jest.useRealTimers();
});

describe("CirclebackError", () => {
  it("is an Error that carries a kind and an optional status", () => {
    const error = new CirclebackError("auth", "bad key", 401);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CirclebackError);
    expect(error.name).toBe("CirclebackError");
    expect(error.message).toBe("bad key");
    expect(error.kind).toBe("auth");
    expect(error.status).toBe(401);
    expect(new CirclebackError("network", "x").status).toBeUndefined();
  });
});

describe("HttpClient: request", () => {
  it("passes throw:false and the bearer header", async () => {
    const { client, requestUrl } = setup();
    await client.getJson("/meetings");
    expect(requestUrl).toHaveBeenCalledTimes(1);
    expect(requestUrl).toHaveBeenCalledWith({
      url: "https://circleback.ai/api/meetings",
      headers: { Authorization: `Bearer ${KEY}` },
      throw: false,
    });
  });

  it("returns the parsed body and the response headers", async () => {
    const { client } = setup([{ status: 200, headers: { Link: "</api/x>; rel=next" }, body: [{ a: 1 }] }]);
    const result = await client.getJson("/meetings");
    expect(result.body).toEqual([{ a: 1 }]);
    expect(result.headers).toEqual({ Link: "</api/x>; rel=next" });
  });

  it("appends a query to a path with ? and to a URL that has a query with &", async () => {
    const { client, requestUrl } = setup([{ status: 200, headers: PAID }]);
    await client.getJson("/meetings", "ownership=All");
    await client.getJson("https://circleback.ai/api/meetings?cursor=abc", "ownership=All&statuses=x");
    const urls = requestUrl.mock.calls.map((call) => (call as unknown as [{ url: string }])[0].url);
    expect(urls).toEqual([
      "https://circleback.ai/api/meetings?ownership=All",
      "https://circleback.ai/api/meetings?cursor=abc&ownership=All&statuses=x",
    ]);
  });

  it("uses an absolute circleback.ai URL as is, and ignores an empty query", async () => {
    const { client, requestUrl } = setup();
    await client.getJson("https://circleback.ai/api/meetings?cursor=abc", "");
    expect(requestUrl).toHaveBeenCalledWith(expect.objectContaining({ url: "https://circleback.ai/api/meetings?cursor=abc" }));
  });

  it.each([
    "https://evil.example.com/api/meetings",
    "http://circleback.ai/api/meetings",
    "https://circleback.ai.evil.example/api/meetings",
    "https://circleback.ai@evil.example/api/meetings",
    "https://circleback.ai:8443/api/meetings",
    "ftp://circleback.ai/api/meetings",
  ])("refuses to send the key to %s", async (url) => {
    const { client, requestUrl } = setup();
    const error = await failure(client.getJson(url));
    expect(error.kind).toBe("invalid-response");
    expect(requestUrl).not.toHaveBeenCalled();
    expect(error.message).not.toContain(KEY);
  });
});

describe("HttpClient: status mapping", () => {
  it.each(AUTH_ERROR_STATUSES)("maps %i to auth", async (status) => {
    const { client } = setup([{ status }]);
    const error = await failure(client.getJson("/meetings"));
    expect(error).toMatchObject({ kind: "auth", status });
  });

  it("maps 403 to forbidden", async () => {
    const { client } = setup([{ status: 403 }]);
    expect(await failure(client.getJson("/meetings"))).toMatchObject({ kind: "forbidden", status: 403 });
  });

  it.each([500, 502, 503])("maps %i to server", async (status) => {
    const { client } = setup([{ status }]);
    expect(await failure(client.getJson("/meetings"))).toMatchObject({ kind: "server", status });
  });

  it("maps other error statuses to invalid-response and includes the API's reason", async () => {
    const { client } = setup([{ status: 400, body: { error: "statuses is not valid" } }]);
    const error = await failure(client.getJson("/meetings"));
    expect(error).toMatchObject({ kind: "invalid-response", status: 400 });
    expect(error.message).toContain("400");
    expect(error.message).toContain("statuses is not valid");
  });

  // Circleback answers a key that is not shaped like a key with 400, not 401.
  it.each([
    ["the token message", "The provided token is invalid."],
    ["the API key message", "The provided API key is invalid."],
    ["different capitals", "INVALID Token"],
    ["API key in other words", "Invalid api key format"],
  ])("maps a 400 that says the key is invalid (%s) to auth, like a 401", async (_label, error) => {
    const { client } = setup([{ status: 400, body: { error } }]);
    const rejected = await failure(client.getJson("/meetings"));
    expect(rejected).toMatchObject({ kind: "auth", status: 400 });
    // The words of a 401, with the status that came.
    expect(rejected.message).toBe("Circleback rejected the API key (HTTP 400). Check the key in the plugin settings.");

    const { client: other } = setup([{ status: 401 }]);
    expect((await failure(other.getJson("/meetings"))).message).toBe(
      "Circleback rejected the API key (HTTP 401). Check the key in the plugin settings.",
    );
  });

  it.each([
    ["another error text", { status: 400, body: { error: "statuses is not valid" } }],
    ["a token that is not called invalid", { status: 400, body: { error: "A token is required." } }],
    ["something else that is invalid", { status: 400, body: { error: "The cursor is invalid." } }],
    ["no error text", { status: 400, body: {} }],
    ["an error that is not text", { status: 400, body: { error: { token: "invalid" } } }],
    ["no JSON body", { status: 400, text: "<html>Bad request</html>" }],
    ["an empty body", { status: 400, text: "" }],
  ] satisfies [string, Reply][])("keeps a 400 with %s as invalid-response", async (_label, step) => {
    const { client } = setup([step]);
    expect(await failure(client.getJson("/meetings"))).toMatchObject({ kind: "invalid-response", status: 400 });
  });

  it("maps only a 400 that way: the same words on another status keep that status's mapping", async () => {
    const body = { error: "The provided token is invalid." };
    const { client: notFound } = setup([{ status: 404, body }]);
    expect(await failure(notFound.getJson("/meetings"))).toMatchObject({ kind: "invalid-response", status: 404 });
    const { client: server } = setup([{ status: 500, body }]);
    expect(await failure(server.getJson("/meetings"))).toMatchObject({ kind: "server", status: 500 });
  });

  it("does not put the API key in the message of a 400 mapped to auth", async () => {
    const { client } = setup([{ status: 400, body: { error: `The provided token ${KEY} is invalid.` } }]);
    const error = await failure(client.getJson("/meetings"));
    expect(error.kind).toBe("auth");
    expect(error.message).not.toContain(KEY);
  });

  it("maps an error status with an unreadable body to invalid-response without a reason", async () => {
    const { client } = setup([{ status: 404, text: "<html>Not found</html>" }]);
    const error = await failure(client.getJson("/meetings"));
    expect(error).toMatchObject({ kind: "invalid-response", status: 404 });
    expect(error.message).not.toContain("<html>");
  });

  it.each([
    ["not json", "<html>hello</html>"],
    ["an empty body", ""],
  ])("maps a 2xx with %s to invalid-response", async (_label, text) => {
    const { client } = setup([{ status: 200, text }]);
    expect(await failure(client.getJson("/meetings"))).toMatchObject({ kind: "invalid-response", status: 200 });
  });

  it("accepts any 2xx", async () => {
    const { client } = setup([{ status: 201, body: { ok: true } }]);
    expect((await client.getJson("/meetings")).body).toEqual({ ok: true });
  });

  it("maps a thrown request to network", async () => {
    const { client } = setup([new Error("net::ERR_NAME_NOT_RESOLVED")]);
    const error = await failure(client.getJson("/meetings"));
    expect(error.kind).toBe("network");
    expect(error.message).toContain("ERR_NAME_NOT_RESOLVED");
  });

  it("maps a request function that throws before returning a promise to network", async () => {
    const requestUrl = jest.fn((): Promise<HttpResponse> => {
      throw new Error("boom");
    });
    const client = new HttpClient(KEY, { requestUrl, sleep: jest.fn(), ...timers });
    expect(await failure(client.getJson("/meetings"))).toMatchObject({ kind: "network" });
  });

  it("never puts the API key in an error message", async () => {
    const leaks: [CirclebackErrorKind, Reply | Error][] = [
      ["network", new Error(`request failed: Authorization: Bearer ${KEY}`)],
      ["network", new Error("request failed: Bearer cb_another_key_987")],
      ["invalid-response", { status: 400, body: { error: `bad header Bearer ${KEY}` } }],
    ];
    for (const [kind, step] of leaks) {
      const { client } = setup([step]);
      const error = await failure(client.getJson("/meetings"));
      expect(error.kind).toBe(kind);
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain("cb_another_key_987");
    }
  });

  it.each([
    [401, "auth"],
    [403, "forbidden"],
    [500, "server"],
  ])("never puts the API key in the %i message", async (status) => {
    const { client } = setup([{ status }]);
    const error = await failure(client.getJson("/meetings"));
    expect(error.message).not.toContain(KEY);
  });
});

describe("HttpClient: timeout", () => {
  it("times out a hung request", async () => {
    const requestUrl = jest.fn(() => new Promise<HttpResponse>(() => undefined));
    const client = new HttpClient(KEY, { requestUrl, sleep: jest.fn(), timeoutMs: 50, ...timers });
    const error = await failure(client.getJson("/meetings"));
    expect(error.kind).toBe("timeout");
    expect(error.message).not.toContain(KEY);
  });

  it("waits 60,000 ms by default", async () => {
    jest.useFakeTimers();
    const requestUrl = jest.fn(() => new Promise<HttpResponse>(() => undefined));
    const client = new HttpClient(KEY, { requestUrl, sleep: jest.fn(), ...timers });
    let outcome: unknown;
    const settled = client.getJson("/meetings").catch((error: unknown) => {
      outcome = error;
    });
    await jest.advanceTimersByTimeAsync(59_999);
    expect(outcome).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    await settled;
    expect(outcome).toMatchObject({ kind: "timeout" });
  });

  it("times out each attempt, including a retry after a 429", async () => {
    let calls = 0;
    const requestUrl = jest.fn((): Promise<HttpResponse> => {
      calls += 1;
      if (calls === 1) return Promise.resolve(reply({ status: 429, headers: { "Retry-After": "1" } }));
      return new Promise<HttpResponse>(() => undefined);
    });
    const client = new HttpClient(KEY, { requestUrl, sleep: jest.fn().mockResolvedValue(undefined), timeoutMs: 50, ...timers });
    expect((await failure(client.getJson("/meetings"))).kind).toBe("timeout");
    expect(calls).toBe(2);
  });

  it("leaves no timer behind after a success, an error status, or a thrown request", async () => {
    jest.useFakeTimers();
    for (const step of [{ status: 200 }, { status: 500 }, new Error("down")]) {
      const { client } = setup([step]);
      await client.getJson("/meetings").catch(() => undefined);
      expect(jest.getTimerCount()).toBe(0);
    }
  });

  it("ignores a late failure from a request that already timed out", async () => {
    let fail: (error: Error) => void = () => undefined;
    const requestUrl = jest.fn(
      () =>
        new Promise<HttpResponse>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const client = new HttpClient(KEY, { requestUrl, sleep: jest.fn(), timeoutMs: 20, ...timers });
    expect((await failure(client.getJson("/meetings"))).kind).toBe("timeout");
    fail(new Error("late"));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

describe("HttpClient: 429 retries", () => {
  it("retries a 429 after Retry-After seconds", async () => {
    const { client, requestUrl, sleep } = setup([
      { status: 429, headers: { "Retry-After": "2" } },
      { status: 200, body: { ok: true } },
    ]);
    const result = await client.getJson("/meetings");
    expect(result.body).toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(requestUrl).toHaveBeenCalledTimes(2);
  });

  it("gives up after 3 rate-limited retries", async () => {
    const { client, requestUrl, sleep } = setup([{ status: 429, headers: { "Retry-After": "1" } }]);
    const error = await failure(client.getJson("/meetings"));
    expect(error).toMatchObject({ kind: "rate-limited", status: 429 });
    expect(requestUrl).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[1000], [1000], [1000]]);
  });

  it("succeeds when the last allowed retry works", async () => {
    const { client, requestUrl } = setup([
      { status: 429, headers: { "Retry-After": "1" } },
      { status: 429, headers: { "Retry-After": "1" } },
      { status: 429, headers: { "Retry-After": "1" } },
      { status: 200, body: "done" },
    ]);
    expect((await client.getJson("/meetings")).body).toBe("done");
    expect(requestUrl).toHaveBeenCalledTimes(4);
  });

  it("waits RateLimit-Reset when a 429 has no Retry-After", async () => {
    const { client, sleep } = setup([{ status: 429, headers: { "RateLimit-Reset": "4" } }, { status: 200 }]);
    await client.getJson("/meetings");
    expect(sleep).toHaveBeenCalledWith(4000);
  });

  it("waits 5 seconds when a 429 says nothing about when to retry", async () => {
    const { client, sleep } = setup([{ status: 429 }, { status: 200 }]);
    await client.getJson("/meetings");
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it("treats an unreadable Retry-After as missing", async () => {
    const { client, sleep } = setup([{ status: 429, headers: { "Retry-After": "soon" } }, { status: 200 }]);
    await client.getJson("/meetings");
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it("gives up at once when asked to wait longer than two minutes", async () => {
    const { client, requestUrl, sleep } = setup([{ status: 429, headers: { "Retry-After": "3600" } }]);
    const error = await failure(client.getJson("/meetings"));
    expect(error).toMatchObject({ kind: "rate-limited", status: 429 });
    expect(requestUrl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("waits the full Retry-After and does not add call spacing on top of it", async () => {
    const { client, sleep } = setup([{ status: 429, headers: { "Retry-After": "1" } }, { status: 200 }]);
    await client.getJson("/meetings");
    expect(sleep.mock.calls).toEqual([[1000]]);
  });
});

describe("HttpClient: throttling", () => {
  it("records RateLimit-Limit", async () => {
    const { client } = setup([{ status: 200, headers: { "RateLimit-Limit": "300" } }]);
    expect(client.rateLimit).toBeUndefined();
    await client.getJson("/meetings");
    expect(client.rateLimit).toBe(300);
  });

  it("records the limit from a 429 too, and follows a plan change", async () => {
    const { client } = setup([
      { status: 429, headers: { "RateLimit-Limit": "20", "Retry-After": "1" } },
      { status: 200, headers: { "RateLimit-Limit": "300" } },
    ]);
    await client.getJson("/meetings");
    expect(client.rateLimit).toBe(300);
  });

  it("ignores a RateLimit-Limit it cannot read", async () => {
    const { client } = setup([{ status: 200, headers: { "RateLimit-Limit": "lots" } }]);
    await client.getJson("/meetings");
    expect(client.rateLimit).toBeUndefined();
  });

  it("waits for RateLimit-Reset when Remaining is 0", async () => {
    const { client, sleep } = setup([
      { status: 200, headers: { ...PAID, "RateLimit-Remaining": "0", "RateLimit-Reset": "5" } },
      { status: 200, headers: PAID },
    ]);
    await client.getJson("/meetings");
    expect(sleep).not.toHaveBeenCalled();
    await client.getJson("/meetings");
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it("counts the time already passed against RateLimit-Reset", async () => {
    const { client, sleep, advance } = setup([
      { status: 200, headers: { ...PAID, "RateLimit-Remaining": "0", "RateLimit-Reset": "5" } },
      { status: 200, headers: PAID },
    ]);
    await client.getJson("/meetings");
    advance(2000);
    await client.getJson("/meetings");
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("does not wait once the reset time has passed", async () => {
    const { client, sleep, advance } = setup([
      { status: 200, headers: { ...PAID, "RateLimit-Remaining": "0", "RateLimit-Reset": "5" } },
      { status: 200, headers: PAID },
    ]);
    await client.getJson("/meetings");
    advance(5000);
    await client.getJson("/meetings");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops waiting once a response shows requests remaining", async () => {
    const { client, sleep } = setup([
      { status: 200, headers: { ...PAID, "RateLimit-Remaining": "0", "RateLimit-Reset": "5" } },
      { status: 200, headers: { ...PAID, "RateLimit-Remaining": "10" } },
      { status: 200, headers: PAID },
    ]);
    await client.getJson("/meetings");
    await client.getJson("/meetings");
    await client.getJson("/meetings");
    expect(sleep.mock.calls).toEqual([[5000]]);
  });

  it("waits 5 seconds when Remaining is 0 and there is no Reset", async () => {
    const { client, sleep } = setup([
      { status: 200, headers: { "RateLimit-Limit": "20", "RateLimit-Remaining": "0" } },
      { status: 200, headers: PAID },
    ]);
    await client.getJson("/meetings");
    await client.getJson("/meetings");
    expect(sleep.mock.calls).toEqual([[5000]]);
  });

  it("refuses the next call when the window will not reset for over two minutes", async () => {
    const { client, requestUrl } = setup([
      { status: 200, headers: { ...PAID, "RateLimit-Remaining": "0", "RateLimit-Reset": "3600" } },
    ]);
    await client.getJson("/meetings");
    const error = await failure(client.getJson("/meetings"));
    expect(error.kind).toBe("rate-limited");
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });

  it("allows the call again once a long reset has nearly passed", async () => {
    const { client, sleep, advance } = setup([
      { status: 200, headers: { ...PAID, "RateLimit-Remaining": "0", "RateLimit-Reset": "130" } },
      { status: 200, headers: PAID },
    ]);
    await client.getJson("/meetings");
    advance(20_000);
    await client.getJson("/meetings");
    expect(sleep).toHaveBeenCalledWith(110_000);
  });

  it("spaces calls 3s apart before any rate headers are seen", async () => {
    const { client, sleep } = setup([{ status: 200 }]);
    await client.getJson("/meetings");
    expect(sleep).not.toHaveBeenCalled();
    await client.getJson("/meetings");
    await client.getJson("/meetings");
    expect(sleep.mock.calls).toEqual([[3000], [3000]]);
  });

  it("counts the time already passed against the 3s spacing", async () => {
    const { client, sleep, advance } = setup([{ status: 200 }]);
    await client.getJson("/meetings");
    advance(1200);
    await client.getJson("/meetings");
    expect(sleep.mock.calls).toEqual([[1800]]);
    advance(3000);
    await client.getJson("/meetings");
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("stops spacing calls once a response carries RateLimit-Limit", async () => {
    const { client, sleep } = setup([{ status: 200, headers: { "RateLimit-Limit": "300" } }]);
    await client.getJson("/meetings");
    await client.getJson("/meetings");
    await client.getJson("/meetings");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("keeps spacing calls when responses carry no rate headers at all", async () => {
    const { client, sleep } = setup([{ status: 200, headers: { "Content-Type": "application/json" } }]);
    for (let i = 0; i < 4; i += 1) await client.getJson("/meetings");
    expect(sleep.mock.calls).toEqual([[3000], [3000], [3000]]);
  });

  it("queues concurrent calls so they are still spaced", async () => {
    const { client, requestUrl, sleep } = setup([{ status: 200 }]);
    await Promise.all([client.getJson("/a"), client.getJson("/b"), client.getJson("/c")]);
    expect(requestUrl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[3000], [3000]]);
  });

  it("keeps working after a call was refused by the throttle", async () => {
    const { client, sleep, advance } = setup([
      { status: 200, headers: { ...PAID, "RateLimit-Remaining": "0", "RateLimit-Reset": "3600" } },
      { status: 200, headers: PAID },
    ]);
    await client.getJson("/meetings");
    await failure(client.getJson("/meetings"));
    advance(3_600_000);
    await client.getJson("/meetings");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("uses the default sleep and clock when none are given", async () => {
    jest.useFakeTimers();
    const requestUrl = jest.fn(async (): Promise<HttpResponse> => reply({ status: 200 }));
    const client = new HttpClient(KEY, { requestUrl, ...timers });
    await client.getJson("/meetings");
    let second = false;
    const pending = client.getJson("/meetings").then(() => {
      second = true;
    });
    await jest.advanceTimersByTimeAsync(2999);
    expect(second).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(second).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("HttpClient: header case", () => {
  it.each([
    ["lowercase", { "ratelimit-limit": "300", "ratelimit-remaining": "0", "ratelimit-reset": "7" }],
    ["uppercase", { "RATELIMIT-LIMIT": "300", "RATELIMIT-REMAINING": "0", "RATELIMIT-RESET": "7" }],
    ["mixed case", { "Ratelimit-Limit": "300", "rateLimit-remaining": "0", "RateLimit-reset": "7" }],
  ])("reads rate limit headers in %s", async (_label, headers) => {
    const { client, sleep } = setup([{ status: 200, headers }, { status: 200 }]);
    await client.getJson("/meetings");
    expect(client.rateLimit).toBe(300);
    await client.getJson("/meetings");
    expect(sleep.mock.calls).toEqual([[7000]]);
  });

  it.each(["retry-after", "RETRY-AFTER", "Retry-after"])("reads %s on a 429", async (name) => {
    const { client, sleep } = setup([{ status: 429, headers: { [name]: "3" } }, { status: 200 }]);
    await client.getJson("/meetings");
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("finds a header in any case with getHeader", () => {
    expect(getHeader({ link: "a" }, "Link")).toBe("a");
    expect(getHeader({ LINK: "a" }, "link")).toBe("a");
    expect(getHeader({ Link: "a" }, "LINK")).toBe("a");
    expect(getHeader({ Other: "a" }, "Link")).toBeUndefined();
    expect(getHeader({}, "Link")).toBeUndefined();
  });
});
