import { readFileSync } from "fs";
import { join } from "path";
import * as v from "valibot";
import {
  ConnectionInfoSchema,
  MeetingListSchema,
  MeetingSchema,
  TranscriptSchema,
} from "../../src/api/schemas";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, "..", "fixtures", name), "utf8")) as unknown;
}

function firstMeeting(): Record<string, unknown> {
  return (fixture("schema-meetings-page.json") as Record<string, unknown>[])[0];
}

describe("schemas: fixtures", () => {
  it("validates the meetings page fixture", () => {
    const result = v.safeParse(MeetingListSchema, fixture("schema-meetings-page.json"));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.output.map((m) => m.id)).toEqual([
      "fixture-meeting-0001",
      "fixture-meeting-0002",
      "fixture-meeting-0003",
    ]);
  });

  it("keeps the values the plugin reads, including nulls", () => {
    const [one, two, three] = v.parse(MeetingListSchema, fixture("schema-meetings-page.json"));
    expect(one.duration).toBe(1800.5);
    expect(one.url).toBe("https://meet.example.com/abc-defg-hij");
    expect(one.tags).toEqual([
      { id: 1, name: "Weekly" },
      { id: 2, name: "Planning" },
    ]);
    expect(one.attendees[2]).toEqual({ profileId: 3, name: "Person B", email: null });
    expect(one.actionItems.map((a) => a.status)).toEqual(["PENDING", "DONE", "PENDING"]);
    expect(one.actionItems[2].assignee).toBeNull();
    expect(one.actionItems[0].assignee).toEqual({ name: "Person A", email: "person.a@example.com" });
    expect(one.insights.Questions[0]).toEqual({
      insight: "Lorem ipsum dolor sit amet?",
      speaker: "Person A",
      timestamp: 49.15,
    });
    expect(one.insights["Customer details"][0].insight).toEqual({
      "Company name": "Example Co",
      "Number of employees": 120,
      "Is customer": true,
      Notes: null,
    });
    expect(two.name).toBeNull();
    expect(two.duration).toBeNull();
    expect(two.privateNotes).toContain("private note");
    expect(three.notes).toBeNull();
  });

  it("reads person, team and workspace sharing entries into one shape", () => {
    const [one, two, three] = v.parse(MeetingListSchema, fixture("schema-meetings-page.json"));
    expect(one.sharedWith).toEqual([
      { name: "Owner Person", email: "owner@example.com", access: "Owner" },
      { name: "Team 1", access: "Viewer" },
    ]);
    expect(two.sharedWith[1]).toEqual({ name: "Workspace 1", access: "LimitedViewer" });
    expect(three.sharedWith[1]).toEqual({ name: "Owner Person", email: "owner@example.com", access: "Viewer" });
  });

  it("validates the transcript fixture", () => {
    const segments = v.parse(TranscriptSchema, fixture("schema-transcript.json"));
    expect(segments).toHaveLength(8);
    expect(segments.filter((s) => s.speaker === null)).toHaveLength(1);
    expect(segments[0]).toEqual({ speaker: "Person A", text: "Lorem ipsum dolor sit amet.", timestamp: 0.5 });
  });

  it("validates the oauth test fixture", () => {
    expect(v.parse(ConnectionInfoSchema, fixture("schema-oauth-test.json"))).toEqual({
      email: "owner@example.com",
      apiKeyName: "Test key",
    });
  });

  it("accepts a connection response without a key name", () => {
    expect(v.parse(ConnectionInfoSchema, { email: "owner@example.com" })).toEqual({ email: "owner@example.com" });
  });
});

describe("schemas: unknown fields", () => {
  it("drops unknown fields at every level and keeps the known ones", () => {
    const meeting = firstMeeting();
    meeting.surprise = "new field";
    (meeting.attendees as Record<string, unknown>[])[0].surprise = 1;
    (meeting.actionItems as Record<string, unknown>[])[0].surprise = 2;
    const parsed = v.parse(MeetingSchema, meeting);
    expect(parsed).not.toHaveProperty("surprise");
    expect(parsed.attendees[0]).not.toHaveProperty("surprise");
    expect(parsed.actionItems[0]).not.toHaveProperty("surprise");
    expect(parsed.id).toBe("fixture-meeting-0001");
    expect(parsed.attendees[0].email).toBe("owner@example.com");
  });

  it("drops OpenAPI fields the plugin does not use", () => {
    const parsed = v.parse(MeetingSchema, firstMeeting());
    for (const key of ["linkAccess", "icalUid", "recordingUrl", "calendarEvent"]) {
      expect(parsed).not.toHaveProperty(key);
    }
    expect(parsed.tags[0]).not.toHaveProperty("description");
    expect(parsed.attendees[0]).not.toHaveProperty("title");
  });

  it("drops unknown fields on transcript segments and connection info", () => {
    const segments = v.parse(TranscriptSchema, [{ speaker: null, text: "x", timestamp: 1, surprise: true }]);
    expect(segments[0]).not.toHaveProperty("surprise");
    const info = v.parse(ConnectionInfoSchema, { email: "a@example.com", surprise: true });
    expect(info).not.toHaveProperty("surprise");
  });
});

describe("schemas: invalid input", () => {
  it("rejects a meeting without an id", () => {
    const meeting = firstMeeting();
    delete meeting.id;
    expect(v.safeParse(MeetingSchema, meeting).success).toBe(false);
  });

  it("rejects a whole page when one meeting is invalid", () => {
    const page = fixture("schema-meetings-page.json") as Record<string, unknown>[];
    delete page[1].id;
    expect(v.safeParse(MeetingListSchema, page).success).toBe(false);
  });

  it("rejects a page that is not an array", () => {
    expect(v.safeParse(MeetingListSchema, { meetings: [] }).success).toBe(false);
  });

  it.each([
    ["createdAt", "not a date"],
    ["updatedAt", ""],
    ["name", 5],
    ["privateNotes", null],
    ["tags", {}],
    ["id", ""],
  ])("rejects a meeting with a bad %s", (field, value) => {
    const meeting = { ...firstMeeting(), [field]: value };
    expect(v.safeParse(MeetingSchema, meeting).success).toBe(false);
  });

  it("rejects an action item with an unknown status", () => {
    const meeting = firstMeeting();
    (meeting.actionItems as Record<string, unknown>[])[0].status = "BLOCKED";
    expect(v.safeParse(MeetingSchema, meeting).success).toBe(false);
  });

  it("rejects a sharing entry with an unknown access level", () => {
    const meeting = firstMeeting();
    (meeting.sharedWith as Record<string, unknown>[])[0].access = "Admin";
    expect(v.safeParse(MeetingSchema, meeting).success).toBe(false);
  });

  it("rejects a transcript segment without text", () => {
    expect(v.safeParse(TranscriptSchema, [{ speaker: "A", timestamp: 1 }]).success).toBe(false);
  });

  it("rejects connection info without an email", () => {
    expect(v.safeParse(ConnectionInfoSchema, { apiKeyName: "Test key" }).success).toBe(false);
  });
});
