import { readFileSync } from "fs";
import { join } from "path";
import { FINISHED_STATUSES, SITE_ORIGIN, serializeStatuses } from "../../src/api/constants";
import { CirclebackClient, parseNextLink } from "../../src/api/circlebackClient";
import { CirclebackError } from "../../src/api/errors";
import { HttpClient } from "../../src/api/http";
import type { HttpResponse } from "../../src/api/http";

const KEY = "cb_test_key_0123456789";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, "..", "fixtures", name), "utf8")) as unknown;
}

function meetingsPage(): Record<string, unknown>[] {
  return fixture("schema-meetings-page.json") as Record<string, unknown>[];
}

const timers = {
  setTimer: (callback: () => void, ms: number): unknown => setTimeout(callback, ms),
  clearTimer: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

// A real HttpClient (so status mapping, the origin guard and URL building are the real
// ones) over a scripted request function. Each reply is used once; the last one repeats.
function setup(...script: Reply[]) {
  let next = 0;
  const requestUrl = jest.fn(async (): Promise<HttpResponse> => {
    const step = script[Math.min(next++, script.length - 1)];
    return { status: step.status, headers: step.headers ?? {}, text: JSON.stringify(step.body ?? {}) };
  });
  const http = new HttpClient(KEY, { requestUrl, sleep: async () => undefined, ...timers });
  http.rateLimit = 300; // a paid plan: calls are not spaced out
  const requestedUrls = (): string[] => requestUrl.mock.calls.map((call) => (call as unknown as [{ url: string }])[0].url);
  return { client: new CirclebackClient(http), requestUrl, requestedUrls };
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

// FINISHED_STATUSES is empty (the API probe found no status value that filters anything),
// which would make every "sends the statuses" check vacuous. These tests fill it in for
// their duration, so the filter still works if a value is found later.
const originalStatuses = [...FINISHED_STATUSES];
function useStatuses(...statuses: string[]): void {
  FINISHED_STATUSES.splice(0, FINISHED_STATUSES.length, ...statuses);
}
afterEach(() => {
  FINISHED_STATUSES.splice(0, FINISHED_STATUSES.length, ...originalStatuses);
});

describe("parseNextLink", () => {
  it("resolves a relative Link header against the site origin", () => {
    expect(parseNextLink('</api/meetings?cursor=abc>; rel="next"')).toBe("https://circleback.ai/api/meetings?cursor=abc");
  });

  it("resolves against SITE_ORIGIN", () => {
    expect(parseNextLink('</x?cursor=1>; rel="next"')).toBe(`${SITE_ORIGIN}/x?cursor=1`);
  });

  it("keeps an absolute URL", () => {
    expect(parseNextLink('<https://circleback.ai/api/meetings?cursor=xyz>; rel="next"')).toBe(
      "https://circleback.ai/api/meetings?cursor=xyz",
    );
  });

  it("returns an absolute URL on another host as is, so the HTTP guard can refuse it when it is requested", () => {
    expect(parseNextLink('<https://evil.example.com/api/meetings?cursor=1>; rel="next"')).toBe(
      "https://evil.example.com/api/meetings?cursor=1",
    );
  });

  it("accepts rel=next without quotes", () => {
    expect(parseNextLink("</api/meetings?cursor=abc>; rel=next")).toBe("https://circleback.ai/api/meetings?cursor=abc");
  });

  it("finds the next link among several, in either order", () => {
    const prev = '</api/meetings?cursor=p>; rel="prev"';
    const next = '</api/meetings?cursor=n>; rel="next"';
    const last = '</api/meetings?cursor=l>; rel="last"';
    expect(parseNextLink(`${prev}, ${next}, ${last}`)).toBe("https://circleback.ai/api/meetings?cursor=n");
    expect(parseNextLink(`${next},${last}`)).toBe("https://circleback.ai/api/meetings?cursor=n");
    expect(parseNextLink(`${last} ,  ${prev} , ${next}`)).toBe("https://circleback.ai/api/meetings?cursor=n");
  });

  it("finds rel among other parameters, whatever the case of the name and value", () => {
    expect(parseNextLink('</a?cursor=1>; title="Next page"; REL="Next"; type="application/json"')).toBe(
      "https://circleback.ai/a?cursor=1",
    );
  });

  it("accepts a rel with several relation types", () => {
    expect(parseNextLink('</a?cursor=1>; rel="prefetch next"')).toBe("https://circleback.ai/a?cursor=1");
  });

  it("does not treat a rel that merely contains the word as next", () => {
    expect(parseNextLink('</a?cursor=1>; rel="nextish"')).toBeNull();
    expect(parseNextLink('</a?cursor=1>; rel="prev"; title="next"')).toBeNull();
  });

  it("is not confused by commas and semicolons inside the URL or a quoted parameter", () => {
    expect(parseNextLink('</a?ids=1,2;3&cursor=x>; rel="next"')).toBe("https://circleback.ai/a?ids=1,2;3&cursor=x");
    expect(parseNextLink('</skip>; title="a, <b>; rel=next"; rel="prev", </go?cursor=2>; rel="next"')).toBe(
      "https://circleback.ai/go?cursor=2",
    );
  });

  it("returns null without a next link", () => {
    expect(parseNextLink(undefined)).toBeNull();
    expect(parseNextLink("")).toBeNull();
    expect(parseNextLink("   ")).toBeNull();
    expect(parseNextLink('</api/meetings?cursor=p>; rel="prev"')).toBeNull();
    expect(parseNextLink('</api/meetings>; title="x"')).toBeNull();
    expect(parseNextLink("</api/meetings>")).toBeNull();
  });

  it.each([
    ["not a link at all", "garbage"],
    ["an unterminated URL", '</api/meetings?cursor=abc; rel="next"'],
    ["an empty URL", '<>; rel="next"'],
    ["a URL that cannot be resolved", '<http://[bad>; rel="next"'],
    ["an unterminated quote", '</api/meetings?cursor=abc>; rel="next'],
    ["a missing separator", '</api/meetings?cursor=abc> rel="next"'],
    ["a comma with nothing after it", '</api/meetings?cursor=abc>; rel="prev",'],
  ])("returns null for a malformed header: %s", (_label, header) => {
    expect(parseNextLink(header)).toBeNull();
  });
});

describe("CirclebackClient.listMeetingsPage", () => {
  it("parses a meetings page fixture", async () => {
    const page = meetingsPage();
    const { client } = setup({ status: 200, body: page });
    const result = await client.listMeetingsPage({ ownership: "Mine" });
    expect(result.meetings).toHaveLength(page.length);
    expect(result.meetings[0].id).toBe(page[0].id);
    expect(result.meetings.map((m) => m.id)).toEqual(page.map((m) => m.id));
  });

  it("returns the next page's URL from the Link header, however the header is named", async () => {
    const link = '</api/meetings?cursor=abc>; rel="next"';
    for (const header of ["Link", "link", "LINK"]) {
      const { client } = setup({ status: 200, headers: { [header]: link }, body: meetingsPage() });
      const result = await client.listMeetingsPage({ ownership: "Mine" });
      expect(result.nextUrl).toBe("https://circleback.ai/api/meetings?cursor=abc");
    }
  });

  it("returns null nextUrl without a next link", async () => {
    const without = setup({ status: 200, body: meetingsPage() });
    expect((await without.client.listMeetingsPage({ ownership: "Mine" })).nextUrl).toBeNull();

    const onlyPrev = setup({ status: 200, headers: { Link: '</api/meetings?cursor=p>; rel="prev"' }, body: meetingsPage() });
    expect((await onlyPrev.client.listMeetingsPage({ ownership: "Mine" })).nextUrl).toBeNull();
  });

  describe("a Link header it cannot rely on", () => {
    it.each([
      ["a header that is not a link", "https://evil.example/leak?cursor=SECRET-CURSOR"],
      ["an unterminated URL", '</api/meetings?cursor=SECRET-CURSOR; rel="next"'],
      ["a next link whose URL cannot be resolved", '<http://[SECRET-CURSOR>; rel="next"'],
      ["a link followed by garbage", '</api/meetings?cursor=SECRET-CURSOR>; rel="next" garbage'],
      ["an unterminated quote", '</api/meetings?cursor=a>; rel="next; title=SECRET-CURSOR'],
    ])("throws invalid-response for %s instead of ending the sync as if it were the last page", async (_label, link) => {
      const { client } = setup({ status: 200, headers: { Link: link }, body: meetingsPage() });
      const error = await failure(client.listMeetingsPage({ ownership: "Mine" }));
      expect(error.kind).toBe("invalid-response");
      expect(error.message).toContain("/meetings");
      expect(error.message).toContain("Link header");
      expect(error.message).not.toContain("SECRET-CURSOR");
      expect(error.message).not.toContain("evil.example");
    });

    it("throws when the header is unreadable on a cursor page too, whatever the header is named", async () => {
      const { client } = setup({ status: 200, headers: { link: "garbage" }, body: meetingsPage() });
      const error = await failure(
        client.listMeetingsPage({ ownership: "Mine", cursorUrl: "https://circleback.ai/api/meetings?cursor=abc" }),
      );
      expect(error.kind).toBe("invalid-response");
    });

    it("gives nextUrl null for a well-formed header with only rel=prev", async () => {
      const { client } = setup({
        status: 200,
        headers: { Link: '</api/meetings?cursor=p>; rel="prev", </api/meetings?cursor=f>; rel="first"' },
        body: meetingsPage(),
      });
      const result = await client.listMeetingsPage({ ownership: "Mine" });
      expect(result.nextUrl).toBeNull();
      expect(result.meetings).toHaveLength(meetingsPage().length);
    });

    it.each([["an empty header", ""], ["a blank header", "   "]])("treats %s as the last page", async (_label, link) => {
      const { client } = setup({ status: 200, headers: { Link: link }, body: meetingsPage() });
      expect((await client.listMeetingsPage({ ownership: "Mine" })).nextUrl).toBeNull();
    });

    it("still returns null from parseNextLink for every one of these headers", () => {
      expect(parseNextLink("https://evil.example/leak")).toBeNull();
      expect(parseNextLink('<http://[bad>; rel="next"')).toBeNull();
    });
  });

  it("returns an empty page", async () => {
    const { client } = setup({ status: 200, body: [] });
    expect(await client.listMeetingsPage({ ownership: "Mine" })).toEqual({ meetings: [], nextUrl: null });
  });

  it("sends ownership and finished statuses", async () => {
    useStatuses("completed", "needs review");
    const { client, requestedUrls } = setup({ status: 200, body: [] });
    await client.listMeetingsPage({ ownership: "All" });
    const [url] = requestedUrls();
    expect(url).toContain("ownership=All");
    expect(url).toContain(serializeStatuses(FINISHED_STATUSES));
    expect(url).toBe("https://circleback.ai/api/meetings?ownership=All&statuses=completed&statuses=needs%20review");
  });

  it("sends only ownership while no finished statuses are known", async () => {
    useStatuses();
    const { client, requestedUrls } = setup({ status: 200, body: [] }, { status: 200, body: [] });
    await client.listMeetingsPage({ ownership: "Mine" });
    await client.listMeetingsPage({ ownership: "All" });
    expect(requestedUrls()).toEqual([
      "https://circleback.ai/api/meetings?ownership=Mine",
      "https://circleback.ai/api/meetings?ownership=All",
    ]);
  });

  describe("following cursorUrl", () => {
    it("keeps the URL's own query and adds the missing ownership and statuses", async () => {
      useStatuses("completed");
      const { client, requestedUrls } = setup({ status: 200, body: [] });
      await client.listMeetingsPage({ ownership: "All", cursorUrl: "https://circleback.ai/api/meetings?cursor=abc" });
      expect(requestedUrls()).toEqual(["https://circleback.ai/api/meetings?cursor=abc&ownership=All&statuses=completed"]);
    });

    it("adds ownership and statuses to a URL that has no query", async () => {
      useStatuses("completed");
      const { client, requestedUrls } = setup({ status: 200, body: [] });
      await client.listMeetingsPage({ ownership: "Mine", cursorUrl: "https://circleback.ai/api/meetings" });
      expect(requestedUrls()).toEqual(["https://circleback.ai/api/meetings?ownership=Mine&statuses=completed"]);
    });

    it("does not repeat or override what the URL already carries", async () => {
      useStatuses("completed");
      const { client, requestedUrls } = setup({ status: 200, body: [] });
      const cursorUrl = "https://circleback.ai/api/meetings?cursor=abc&ownership=Mine&statuses=archived";
      await client.listMeetingsPage({ ownership: "All", cursorUrl });
      expect(requestedUrls()).toEqual([cursorUrl]);
    });

    it("adds only the part that is missing", async () => {
      useStatuses("completed");
      const { client, requestedUrls } = setup({ status: 200, body: [] }, { status: 200, body: [] });
      await client.listMeetingsPage({ ownership: "All", cursorUrl: "https://circleback.ai/api/meetings?cursor=a&ownership=Mine" });
      await client.listMeetingsPage({ ownership: "All", cursorUrl: "https://circleback.ai/api/meetings?cursor=b&statuses=archived" });
      expect(requestedUrls()).toEqual([
        "https://circleback.ai/api/meetings?cursor=a&ownership=Mine&statuses=completed",
        "https://circleback.ai/api/meetings?cursor=b&statuses=archived&ownership=All",
      ]);
    });

    it("is not confused by a query value that merely contains the names", async () => {
      useStatuses();
      const { client, requestedUrls } = setup({ status: 200, body: [] });
      await client.listMeetingsPage({ ownership: "Mine", cursorUrl: "https://circleback.ai/api/meetings?cursor=my_ownership=1" });
      expect(requestedUrls()).toEqual(["https://circleback.ai/api/meetings?cursor=my_ownership=1&ownership=Mine"]);
    });

    it("never sends the key to another host", async () => {
      const { client, requestUrl } = setup({ status: 200, body: [] });
      const error = await failure(
        client.listMeetingsPage({ ownership: "Mine", cursorUrl: "https://evil.example.com/api/meetings?cursor=abc" }),
      );
      expect(error.kind).toBe("invalid-response");
      expect(requestUrl).not.toHaveBeenCalled();
    });
  });

  describe("validation (Review Focus 3)", () => {
    it("rejects an invalid page with invalid-response", async () => {
      const { client } = setup({ status: 200, body: [{ id: 5 }] });
      const error = await failure(client.listMeetingsPage({ ownership: "Mine" }));
      expect(error.kind).toBe("invalid-response");
    });

    it("names the endpoint and the first problem, and nothing from the meeting", async () => {
      const bad = { ...meetingsPage()[0], name: "Secret board meeting about the layoffs", createdAt: "Secret board date" };
      const { client } = setup({ status: 200, body: [bad] });
      const error = await failure(client.listMeetingsPage({ ownership: "Mine" }));
      expect(error.message).toContain("/meetings");
      expect(error.message).toContain("0.createdAt");
      expect(error.message).not.toContain("Secret");
      expect(error.message).not.toContain("layoffs");
      expect(error.message).not.toContain(KEY);
    });

    it("fails the whole page when one meeting among several is invalid", async () => {
      const [first, second] = meetingsPage();
      const { client } = setup({ status: 200, body: [first, { ...second, attendees: "nobody" }] });
      const error = await failure(client.listMeetingsPage({ ownership: "Mine" }));
      expect(error.kind).toBe("invalid-response");
      expect(error.message).toContain("1.attendees");
    });

    it("keeps meeting content out of the message when the bad value sits under a key the data chooses", async () => {
      const meeting = { ...meetingsPage()[0], insights: { "Confidential insight name": [{ insight: 7, speaker: null, timestamp: null }] } };
      const { client } = setup({ status: 200, body: [meeting] });
      const error = await failure(client.listMeetingsPage({ ownership: "Mine" }));
      expect(error.kind).toBe("invalid-response");
      expect(error.message).toContain("0.insights");
      expect(error.message).not.toContain("Confidential");
    });

    it.each([
      ["a tag", (m: Record<string, unknown>) => ({ ...m, tags: [{ id: 1, name: "ok" }, { id: 2, name: 9 }] }), "0.tags.1.name"],
      ["an attendee", (m: Record<string, unknown>) => ({ ...m, attendees: [{ profileId: "x", name: null, email: null }] }), "0.attendees.0.profileId"],
      ["an action item", (m: Record<string, unknown>) => ({ ...m, actionItems: [{ id: 1, title: "t", description: "d", assignee: null, status: "LATER" }] }), "0.actionItems.0.status"],
      ["a shared entry", (m: Record<string, unknown>) => ({ ...m, sharedWith: [{ name: null, access: "Boss" }] }), "0.sharedWith.0.access"],
      ["an insight", (m: Record<string, unknown>) => ({ ...m, insights: { "Hidden name": [{ insight: "ok", speaker: 5, timestamp: null }] } }), "0.insights.*.0.speaker"],
      ["an insight with a bad custom field", (m: Record<string, unknown>) => ({ ...m, insights: { "Hidden name": [{ insight: { "Hidden field": [] }, speaker: null, timestamp: null }] } }), "0.insights.*.0.insight"],
    ])("points at the problem in %s without quoting data-chosen keys", async (_label, damage, path) => {
      const { client } = setup({ status: 200, body: [damage(meetingsPage()[0])] });
      const error = await failure(client.listMeetingsPage({ ownership: "Mine" }));
      expect(error.message).toContain(`first problem: ${path})`);
      expect(error.message).not.toContain("Hidden");
    });

    it.each([
      ["an object instead of a list", { meetings: [] }],
      ["null", null],
      ["a string", "meetings"],
    ])("rejects %s", async (_label, body) => {
      const { client } = setup({ status: 200, body });
      const error = await failure(client.listMeetingsPage({ ownership: "Mine" }));
      expect(error.kind).toBe("invalid-response");
      expect(error.message).toContain("/meetings");
    });

    it("lets HTTP errors through with their own kind", async () => {
      const auth = setup({ status: 401 });
      expect((await failure(auth.client.listMeetingsPage({ ownership: "Mine" }))).kind).toBe("auth");
      const server = setup({ status: 503 });
      expect((await failure(server.client.listMeetingsPage({ ownership: "Mine" }))).kind).toBe("server");
    });
  });
});

describe("CirclebackClient.getTranscript", () => {
  it("parses the transcript fixture", async () => {
    const segments = fixture("schema-transcript.json") as { text: string }[];
    const { client, requestedUrls } = setup({ status: 200, body: segments });
    const result = await client.getTranscript("fixture-meeting-0001");
    expect(result).toHaveLength(segments.length);
    expect(result?.[0]).toEqual(segments[0]);
    expect(requestedUrls()).toEqual(["https://circleback.ai/api/meeting/fixture-meeting-0001/transcript"]);
  });

  it("returns an empty transcript as an empty list", async () => {
    const { client } = setup({ status: 200, body: [] });
    expect(await client.getTranscript("m1")).toEqual([]);
  });

  it("encodes the meeting id in the path", async () => {
    const { client, requestedUrls } = setup({ status: 200, body: [] });
    await client.getTranscript("a/b?c");
    expect(requestedUrls()).toEqual(["https://circleback.ai/api/meeting/a%2Fb%3Fc/transcript"]);
  });

  it("returns null transcript on 403", async () => {
    const { client } = setup({ status: 403 });
    expect(await client.getTranscript("m1")).toBeNull();
  });

  it("returns an empty transcript on 404, Circleback's answer for a meeting with no transcript", async () => {
    // The body the real API sends for a meeting that was never recorded.
    const { client } = setup({ status: 404, body: { error: "Transcript not found for meeting m1." } });
    expect(await client.getTranscript("m1")).toEqual([]);
  });

  it.each([
    [400, "invalid-response"],
    [401, "auth"],
    [410, "invalid-response"],
    [503, "server"],
  ])("lets a %i through as %s", async (status, kind) => {
    const { client } = setup({ status });
    expect((await failure(client.getTranscript("m1"))).kind).toBe(kind);
  });

  it("still fails on a 404 from the other endpoints", async () => {
    const list = setup({ status: 404, body: { error: "Not found." } });
    const listError = await failure(list.client.listMeetingsPage({ ownership: "Mine" }));
    expect(listError).toMatchObject({ kind: "invalid-response", status: 404 });

    const connection = setup({ status: 404, body: { error: "Not found." } });
    expect(await failure(connection.client.testConnection())).toMatchObject({ kind: "invalid-response", status: 404 });
  });

  it("rejects an invalid transcript with invalid-response, naming the endpoint but not the text", async () => {
    const { client } = setup({ status: 200, body: [{ speaker: "A", text: "Private words", timestamp: "soon" }] });
    const error = await failure(client.getTranscript("m1"));
    expect(error.kind).toBe("invalid-response");
    expect(error.message).toContain("transcript");
    expect(error.message).toContain("0.timestamp");
    expect(error.message).not.toContain("Private");
    expect(error.message).not.toContain("soon");
  });
});

describe("CirclebackClient.testConnection", () => {
  it("testConnection returns the email", async () => {
    const info = fixture("schema-oauth-test.json") as { email: string; apiKeyName: string };
    const { client, requestedUrls } = setup({ status: 200, body: info });
    const result = await client.testConnection();
    expect(result.email).toBe(info.email);
    expect(result.apiKeyName).toBe(info.apiKeyName);
    expect(requestedUrls()).toEqual(["https://circleback.ai/api/oauth/test"]);
  });

  it("accepts a response without the key name and drops unknown fields", async () => {
    const { client } = setup({ status: 200, body: { email: "a@example.com", name: "Someone" } });
    expect(await client.testConnection()).toEqual({ email: "a@example.com" });
  });

  it("rejects a response without an email with invalid-response", async () => {
    const { client } = setup({ status: 200, body: { apiKeyName: "Test key" } });
    const error = await failure(client.testConnection());
    expect(error.kind).toBe("invalid-response");
    expect(error.message).toContain("/oauth/test");
  });

  it("lets a rejected key through as auth", async () => {
    const { client } = setup({ status: 401 });
    expect((await failure(client.testConnection())).kind).toBe("auth");
  });
});

describe("CirclebackClient.rateLimit", () => {
  it("is the account's limit once a response has given it, and undefined before", async () => {
    const requestUrl = jest.fn(async (): Promise<HttpResponse> => ({
      status: 200,
      headers: { "RateLimit-Limit": "20" },
      text: JSON.stringify({ email: "a@example.com" }),
    }));
    const client = new CirclebackClient(new HttpClient(KEY, { requestUrl, sleep: async () => undefined, ...timers }));
    expect(client.rateLimit).toBeUndefined();
    await client.testConnection();
    expect(client.rateLimit).toBe(20);
  });
});
