import {
  API_BASE,
  AUTH_ERROR_STATUSES,
  FINISHED_STATUSES,
  LIST_IS_NEWEST_FIRST,
  MEETING_START_FIELD,
  NOTES_HAVE_ACTION_ITEMS,
  SITE_ORIGIN,
  serializeStatuses,
} from "../../src/api/constants";
import type { Meeting } from "../../src/api/schemas";

describe("constants", () => {
  it("has the final base URLs", () => {
    expect(API_BASE).toBe("https://circleback.ai/api");
    expect(SITE_ORIGIN).toBe("https://circleback.ai");
  });

  it("starts with the provisional values the probe will confirm", () => {
    expect(FINISHED_STATUSES).toEqual([]);
    expect(LIST_IS_NEWEST_FIRST).toBe(false);
    expect(AUTH_ERROR_STATUSES).toEqual([401]);
  });

  it("names a string field of a meeting as the start time", () => {
    const meeting = { createdAt: "2026-10-26T15:00:00.000Z", updatedAt: "2026-10-26T16:00:00.000Z" } as Meeting;
    const start: string = meeting[MEETING_START_FIELD];
    expect(start).toBe(meeting.createdAt);
  });

  it("rejects a non-timestamp field as the start time at compile time", () => {
    // @ts-expect-error `duration` is a number, so it cannot be the start field.
    const bad: typeof MEETING_START_FIELD = "duration";
    expect(bad).toBe("duration");
  });
});

describe("serializeStatuses", () => {
  it("returns an empty string for no statuses", () => {
    expect(serializeStatuses([])).toBe("");
  });

  it("repeats the key for each status", () => {
    expect(serializeStatuses(["a", "b"])).toBe("statuses=a&statuses=b");
  });

  it("URL-encodes each status", () => {
    expect(serializeStatuses(["in progress", "a&b=c"])).toBe("statuses=in%20progress&statuses=a%26b%3Dc");
  });
});

describe("NOTES_HAVE_ACTION_ITEMS", () => {
  it.each(["## Action Items", "#### action items", "# ACTION ITEMS  ", "intro\n### Action Items\n* x"])(
    "matches %j",
    (notes) => {
      expect(NOTES_HAVE_ACTION_ITEMS.test(notes)).toBe(true);
    },
  );

  it.each(["Action Items", "####### Action Items", "## Action Items for later", "#Action Items", "no heading here"])(
    "does not match %j",
    (notes) => {
      expect(NOTES_HAVE_ACTION_ITEMS.test(notes)).toBe(false);
    },
  );
});
