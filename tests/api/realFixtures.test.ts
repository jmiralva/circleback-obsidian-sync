// The scrubbed fixtures captured from the real Circleback API (Task 2 probe; see
// tests/fixtures/README.md). They pin what real responses look like, so a schema or client
// change that would reject real data fails here.
import { readFileSync } from "fs";
import { join } from "path";
import * as v from "valibot";
import { CirclebackClient } from "../../src/api/circlebackClient";
import { CirclebackError } from "../../src/api/errors";
import { HttpClient } from "../../src/api/http";
import type { HttpResponse } from "../../src/api/http";
import {
  ConnectionInfoSchema,
  MeetingListSchema,
  MeetingSchema,
  TranscriptSchema,
  type ConnectionInfo,
  type Meeting,
  type TranscriptSegment,
} from "../../src/api/schemas";
import { findOwner, ownsMeeting } from "../../src/format/owner";
import { keepMeeting } from "../../src/sync/select";

function raw(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, "..", "fixtures", name), "utf8")) as unknown;
}

const page1 = (): Meeting[] => v.parse(MeetingListSchema, raw("meetings-page-1.json"));
const page2 = (): Meeting[] => v.parse(MeetingListSchema, raw("meetings-page-2.json"));
const meeting = (): Meeting => v.parse(MeetingSchema, raw("meeting.json"));
const transcript = (): TranscriptSegment[] => v.parse(TranscriptSchema, raw("transcript.json"));
const oauth = (): ConnectionInfo => v.parse(ConnectionInfoSchema, raw("oauth-test.json"));

// Headers as the real API sent them (values from the probe, nothing confidential in them).
const PAGE_1_LINK = '</api/meetings?ownership=Mine&cursor=eyJwYWdlIjoxfQ>; rel="next"';
const RATE_HEADERS = { "ratelimit-limit": "3", "ratelimit-remaining": "2", "ratelimit-reset": "1" };

const timers = {
  setTimer: (callback: () => void, ms: number): unknown => setTimeout(callback, ms),
  clearTimer: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Reply {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

function setup(...script: Reply[]) {
  let next = 0;
  const requestUrl = jest.fn(async (): Promise<HttpResponse> => {
    const step = script[Math.min(next++, script.length - 1)];
    return { status: step.status, headers: step.headers ?? {}, text: JSON.stringify(step.body) };
  });
  const http = new HttpClient("cb_test_key_0123456789", { requestUrl, sleep: async () => undefined, ...timers });
  const requestedUrls = (): string[] => requestUrl.mock.calls.map((call) => (call as unknown as [{ url: string }])[0].url);
  return { client: new CirclebackClient(http), requestedUrls };
}

describe("real fixtures: schemas", () => {
  it.each([
    ["meetings-page-1.json", MeetingListSchema],
    ["meetings-page-2.json", MeetingListSchema],
    ["meeting.json", MeetingSchema],
    ["transcript.json", TranscriptSchema],
    ["oauth-test.json", ConnectionInfoSchema],
  ] as const)("%s validates", (name, schema) => {
    expect(v.safeParse(schema as v.GenericSchema, raw(name)).success).toBe(true);
  });

  it("has the page sizes the API returns: 20 a page, the last page shorter", () => {
    expect(page1()).toHaveLength(20);
    expect(page2()).toHaveLength(18);
  });

  it("lists meetings newest first, across pages", () => {
    const starts = [...page1(), ...page2()].map((m) => Date.parse(m.createdAt));
    for (let i = 1; i < starts.length; i += 1) expect(starts[i]).toBeLessThanOrEqual(starts[i - 1]);
  });

  it("returns the same meeting from GET /meeting/{id} as from the list", () => {
    const one = meeting();
    expect(page1().find((m) => m.id === one.id)).toEqual(one);
  });

  it("keeps the nulls real data has", () => {
    const all = [...page1(), ...page2()];
    expect(all.filter((m) => m.notes === null)).toHaveLength(2);
    expect(all.filter((m) => m.duration === null)).toHaveLength(2);
    expect(all.filter((m) => m.url === null)).toHaveLength(2);
    expect(all.some((m) => m.attendees.some((a) => a.name === null))).toBe(true);
    expect(all.some((m) => m.attendees.some((a) => a.email === null))).toBe(true);
    expect(all.some((m) => m.actionItems.some((a) => a.assignee === null))).toBe(true);
  });

  it("skips the meetings that have no notes", () => {
    const settings = { titleFilterMode: "disabled", titleFilterKeyword: "" } as const;
    const kept = [...page1(), ...page2()].filter((m) => keepMeeting(m, settings, null));
    expect(kept).toHaveLength(36);
  });
});

describe("real fixtures: the key owner", () => {
  it("owns every meeting through its single sharedWith entry", () => {
    const { email } = oauth();
    for (const m of [...page1(), ...page2()]) {
      expect(m.sharedWith).toEqual([expect.objectContaining({ access: "Owner", email })]);
      expect(ownsMeeting(m, email)).toBe(true);
    }
  });

  it("is an attendee under the same name, and speaks in the transcript under it", () => {
    const owner = findOwner(meeting(), oauth().email);
    expect(owner).toEqual({ name: "Person A", profileId: expect.any(Number) as number });
    const speakers = new Set(transcript().map((s) => s.speaker));
    expect(speakers.has("Person A")).toBe(true);
    // Every speaker label is an attendee's name.
    const names = new Set(meeting().attendees.map((a) => a.name));
    for (const speaker of speakers) expect(names.has(speaker)).toBe(true);
  });
});

describe("real fixtures: CirclebackClient", () => {
  it("parses a real first page and follows its relative Link header", async () => {
    const { client, requestedUrls } = setup(
      { status: 200, headers: { link: PAGE_1_LINK, ...RATE_HEADERS }, body: raw("meetings-page-1.json") },
      { status: 200, headers: { "ratelimit-limit": "20", "ratelimit-remaining": "13", "ratelimit-reset": "24" }, body: raw("meetings-page-2.json") },
    );
    const first = await client.listMeetingsPage({ ownership: "Mine" });
    expect(first.meetings).toEqual(page1());
    expect(first.nextUrl).toBe("https://circleback.ai/api/meetings?ownership=Mine&cursor=eyJwYWdlIjoxfQ");
    expect(client.rateLimit).toBe(3);

    // The real link already carries `ownership`, so it is not added twice.
    const second = await client.listMeetingsPage({ ownership: "Mine", cursorUrl: first.nextUrl ?? undefined });
    expect(second.meetings).toEqual(page2());
    expect(second.nextUrl).toBeNull();
    expect(requestedUrls()).toEqual([
      "https://circleback.ai/api/meetings?ownership=Mine",
      "https://circleback.ai/api/meetings?ownership=Mine&cursor=eyJwYWdlIjoxfQ",
    ]);
    expect(client.rateLimit).toBe(20);
  });

  it("parses a real transcript", async () => {
    const { client } = setup({ status: 200, headers: RATE_HEADERS, body: raw("transcript.json") });
    expect(await client.getTranscript(meeting().id)).toEqual(transcript());
  });

  it("parses a real connection test", async () => {
    const { client } = setup({ status: 200, headers: RATE_HEADERS, body: raw("oauth-test.json") });
    expect(await client.testConnection()).toEqual({ email: "person.a@example.com", apiKeyName: "Probe key" });
  });

  it("reports the real bad-key response as an auth error", async () => {
    const { client } = setup({ status: 401, body: { error: "The provided API key is invalid." } });
    const error = await client.testConnection().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CirclebackError);
    expect((error as CirclebackError).kind).toBe("auth");
  });
});
