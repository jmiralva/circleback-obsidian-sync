import { readFileSync } from "fs";
import { join } from "path";
import * as v from "valibot";
import { LIST_IS_NEWEST_FIRST, MEETING_START_FIELD } from "../../src/api/constants";
import { MeetingListSchema, type Meeting } from "../../src/api/schemas";
import { assignWriters, keepMeeting, pageIsPastWindow, windowStart } from "../../src/sync/select";

function fixtureMeetings(): Meeting[] {
  const raw = JSON.parse(
    readFileSync(join(__dirname, "..", "fixtures", "schema-meetings-page.json"), "utf8"),
  ) as unknown;
  return v.parse(MeetingListSchema, raw);
}

// Meeting 1: named "Meeting 1", has notes, owned by owner@example.com.
// Meeting 3: owned by person.a@example.com, with owner@example.com as a Viewer. Its notes are null.
const [one, , three] = fixtureMeetings();

/** A meeting that starts at `startIso` (read through the field the plugin treats as the start). */
function meetingAt(startIso: string, overrides: Partial<Meeting> = {}): Meeting {
  return { ...one, [MEETING_START_FIELD]: startIso, ...overrides };
}

const NO_FILTER = { titleFilterMode: "disabled", titleFilterKeyword: "" } as const;
const START = new Date("2026-10-20T00:00:00.000Z");

describe("windowStart", () => {
  it("is the given number of 24-hour days before now", () => {
    const now = new Date("2026-10-27T18:30:00.000Z");
    expect(windowStart(now, 7).toISOString()).toBe("2026-10-20T18:30:00.000Z");
    expect(windowStart(now, 1).toISOString()).toBe("2026-10-26T18:30:00.000Z");
  });

  it("counts 24 hours a day, so a DST change in between does not move it", () => {
    // Clocks in Chicago go back on 2026-11-01. Seven calendar days before 11-02 06:00 local
    // would be 11:00 UTC on 10-26, so only a fixed 168 hours lands on 12:00 UTC.
    const now = new Date("2026-11-02T12:00:00.000Z");
    expect(windowStart(now, 7).toISOString()).toBe("2026-10-26T12:00:00.000Z");
  });

  it("is now itself for zero days, and does not change its argument", () => {
    const now = new Date("2026-10-27T18:30:00.000Z");
    expect(windowStart(now, 0).getTime()).toBe(now.getTime());
    windowStart(now, 7);
    expect(now.toISOString()).toBe("2026-10-27T18:30:00.000Z");
  });
});

describe("pageIsPastWindow", () => {
  const old = meetingAt("2026-10-10T12:00:00.000Z");
  const inWindow = meetingAt("2026-10-25T12:00:00.000Z");

  it("stops paging when a whole page is older than the window", () => {
    const older = meetingAt("2026-10-15T12:00:00.000Z");
    expect(pageIsPastWindow([old, older], START, true)).toBe(true);
  });

  it("keeps paging while any meeting on the page is in the window", () => {
    expect(pageIsPastWindow([inWindow, old], START, true)).toBe(false);
    expect(pageIsPastWindow([old, inWindow], START, true)).toBe(false);
  });

  it("counts a meeting that starts exactly at the window start as in the window", () => {
    const atStart = meetingAt(START.toISOString());
    expect(pageIsPastWindow([old, atStart], START, true)).toBe(false);
  });

  it("never stops on an empty page, since it says nothing about the window", () => {
    expect(pageIsPastWindow([], START, true)).toBe(false);
  });

  it("never stops when the list is not newest first, even if the whole page is old", () => {
    expect(pageIsPastWindow([old], START, false)).toBe(false);
  });

  it("follows LIST_IS_NEWEST_FIRST when not told otherwise", () => {
    expect(pageIsPastWindow([old], START)).toBe(LIST_IS_NEWEST_FIRST);
  });
});

describe("keepMeeting", () => {
  const recent = meetingAt("2026-10-25T12:00:00.000Z", { name: "Weekly Standup" });

  it("drops meetings with null notes", () => {
    expect(keepMeeting(meetingAt("2026-10-25T12:00:00.000Z", { notes: null }), NO_FILTER, START)).toBe(false);
    expect(keepMeeting(meetingAt("2026-10-25T12:00:00.000Z", { notes: null }), NO_FILTER, null)).toBe(false);
  });

  it("keeps meetings whose notes are an empty string", () => {
    expect(keepMeeting(meetingAt("2026-10-25T12:00:00.000Z", { notes: "" }), NO_FILTER, START)).toBe(true);
  });

  it("drops meetings that start before the window and keeps the ones at or after it", () => {
    expect(keepMeeting(meetingAt("2026-10-19T23:59:59.999Z"), NO_FILTER, START)).toBe(false);
    expect(keepMeeting(meetingAt(START.toISOString()), NO_FILTER, START)).toBe(true);
    expect(keepMeeting(recent, NO_FILTER, START)).toBe(true);
  });

  it("full sync (start null) keeps old meetings", () => {
    expect(keepMeeting(meetingAt("2019-01-01T00:00:00.000Z"), NO_FILTER, null)).toBe(true);
  });

  it("applies include and exclude title filters case-insensitively", () => {
    const include = { titleFilterMode: "include", titleFilterKeyword: "STANDUP" } as const;
    const exclude = { titleFilterMode: "exclude", titleFilterKeyword: "standUP" } as const;
    expect(keepMeeting(recent, include, START)).toBe(true);
    expect(keepMeeting(recent, exclude, START)).toBe(false);

    const other = meetingAt("2026-10-25T12:00:00.000Z", { name: "Customer call" });
    expect(keepMeeting(other, include, START)).toBe(false);
    expect(keepMeeting(other, exclude, START)).toBe(true);
  });

  it("matches the keyword anywhere in the title", () => {
    const include = { titleFilterMode: "include", titleFilterKeyword: "kly stand" } as const;
    expect(keepMeeting(recent, include, START)).toBe(true);
  });

  it("filters nothing when the mode is disabled, even with a keyword set", () => {
    const disabled = { titleFilterMode: "disabled", titleFilterKeyword: "nomatch" } as const;
    expect(keepMeeting(recent, disabled, START)).toBe(true);
  });

  it("filters nothing when the keyword is empty, in either mode", () => {
    expect(keepMeeting(recent, { titleFilterMode: "include", titleFilterKeyword: "" }, START)).toBe(true);
    expect(keepMeeting(recent, { titleFilterMode: "exclude", titleFilterKeyword: "" }, START)).toBe(true);
  });

  it("filters on the title the note shows, which is 'Untitled meeting' when the meeting has no name", () => {
    const unnamed = meetingAt("2026-10-25T12:00:00.000Z", { name: null });
    expect(keepMeeting(unnamed, { titleFilterMode: "exclude", titleFilterKeyword: "untitled" }, START)).toBe(false);
    expect(keepMeeting(unnamed, { titleFilterMode: "include", titleFilterKeyword: "untitled" }, START)).toBe(true);
    // Blank names fall back the same way.
    const blank = meetingAt("2026-10-25T12:00:00.000Z", { name: "   " });
    expect(keepMeeting(blank, { titleFilterMode: "include", titleFilterKeyword: "untitled" }, START)).toBe(true);
  });

  it("still drops an old or note-less meeting whose title passes the filter", () => {
    const include = { titleFilterMode: "include", titleFilterKeyword: "standup" } as const;
    const old = meetingAt("2026-10-01T12:00:00.000Z", { name: "Weekly Standup" });
    expect(keepMeeting(old, include, START)).toBe(false);
    expect(keepMeeting(old, include, null)).toBe(true);
    expect(keepMeeting({ ...recent, notes: null }, include, START)).toBe(false);
  });
});

describe("assignWriters", () => {
  const OWNER_EMAIL = "person.a@example.com";
  const VIEWER_EMAIL = "owner@example.com";

  /** Meeting 3 as one account fetched it. The private notes are the key user's own, so copies differ. */
  function sharedCopy(privateNotes: string): Meeting {
    return { ...three, notes: "Shared notes.", privateNotes };
  }

  it("assigns a shared meeting to its owner's account", () => {
    const viewerCopy = sharedCopy("viewer's private notes");
    const ownerCopy = sharedCopy("owner's private notes");
    const writers = assignWriters([
      { accountId: "u1", ownerEmail: VIEWER_EMAIL, meetings: [viewerCopy] },
      { accountId: "u2", ownerEmail: OWNER_EMAIL, meetings: [ownerCopy] },
    ]);
    expect(writers.size).toBe(1);
    expect(writers.get(three.id)?.accountId).toBe("u2");
  });

  it("returns the chosen account's own copy of the meeting, never another account's", () => {
    const viewerCopy = sharedCopy("viewer's private notes");
    const ownerCopy = sharedCopy("owner's private notes");
    const writers = assignWriters([
      { accountId: "u1", ownerEmail: VIEWER_EMAIL, meetings: [viewerCopy] },
      { accountId: "u2", ownerEmail: OWNER_EMAIL, meetings: [ownerCopy] },
    ]);
    expect(writers.get(three.id)?.meeting).toBe(ownerCopy);
  });

  it("keeps the owner when the owner's account comes first", () => {
    const ownerCopy = sharedCopy("owner's private notes");
    const writers = assignWriters([
      { accountId: "u2", ownerEmail: OWNER_EMAIL, meetings: [ownerCopy] },
      { accountId: "u1", ownerEmail: VIEWER_EMAIL, meetings: [sharedCopy("viewer's private notes")] },
    ]);
    expect(writers.get(three.id)).toEqual({ meeting: ownerCopy, accountId: "u2" });
  });

  it("falls back to the first account when no owner is connected", () => {
    const first = sharedCopy("first account's copy");
    const second = sharedCopy("second account's copy");
    const writers = assignWriters([
      { accountId: "u1", ownerEmail: VIEWER_EMAIL, meetings: [first] },
      { accountId: "u2", ownerEmail: "someone.else@example.com", meetings: [second] },
    ]);
    expect(writers.size).toBe(1);
    expect(writers.get(three.id)).toEqual({ meeting: first, accountId: "u1" });
    expect(writers.get(three.id)?.meeting).toBe(first);
  });

  it("lets the first account in order win when two both claim ownership", () => {
    const ownedByBoth = (id: string): Meeting => ({
      ...one,
      id,
      sharedWith: [
        { name: "A", email: "a@example.com", access: "Owner" },
        { name: "B", email: "b@example.com", access: "Owner" },
      ],
    });
    const copyA = ownedByBoth("shared-1");
    const copyB = ownedByBoth("shared-1");
    const writers = assignWriters([
      { accountId: "b", ownerEmail: "b@example.com", meetings: [copyB] },
      { accountId: "a", ownerEmail: "a@example.com", meetings: [copyA] },
    ]);
    expect(writers.get("shared-1")?.accountId).toBe("b");
    expect(writers.get("shared-1")?.meeting).toBe(copyB);
  });

  it("dedupes a meeting id seen twice by one account", () => {
    const firstSighting = { ...one };
    const secondSighting = { ...one };
    const writers = assignWriters([
      { accountId: "u1", ownerEmail: "owner@example.com", meetings: [firstSighting, secondSighting] },
    ]);
    expect(writers.size).toBe(1);
    expect(writers.get(one.id)?.meeting).toBe(firstSighting);
  });

  it("dedupes a meeting id seen twice by a non-owning account", () => {
    const first = sharedCopy("first sighting");
    const second = sharedCopy("second sighting");
    const writers = assignWriters([{ accountId: "u1", ownerEmail: VIEWER_EMAIL, meetings: [first, second] }]);
    expect(writers.size).toBe(1);
    expect(writers.get(three.id)?.meeting).toBe(first);
  });

  it("keeps a meeting only one account sees, with that account", () => {
    const solo = meetingAt("2026-10-25T12:00:00.000Z", { id: "solo-meeting" });
    const writers = assignWriters([
      { accountId: "u1", ownerEmail: VIEWER_EMAIL, meetings: [] },
      { accountId: "u2", ownerEmail: OWNER_EMAIL, meetings: [solo] },
    ]);
    expect(writers.get("solo-meeting")).toEqual({ meeting: solo, accountId: "u2" });
  });

  it("decides each meeting on its own", () => {
    // u1 owns meeting 1 and only views meeting 3. u2 owns meeting 3 and also sees meeting 1.
    const oneForU1 = { ...one };
    const oneForU2 = { ...one };
    const threeForU1 = sharedCopy("u1's copy");
    const threeForU2 = sharedCopy("u2's copy");
    const writers = assignWriters([
      { accountId: "u1", ownerEmail: VIEWER_EMAIL, meetings: [oneForU1, threeForU1] },
      { accountId: "u2", ownerEmail: OWNER_EMAIL, meetings: [threeForU2, oneForU2] },
    ]);
    expect([...writers.keys()].sort()).toEqual([one.id, three.id].sort());
    expect(writers.get(one.id)).toEqual({ meeting: oneForU1, accountId: "u1" });
    expect(writers.get(three.id)).toEqual({ meeting: threeForU2, accountId: "u2" });
  });

  it("returns an empty map when there are no accounts or no meetings", () => {
    expect(assignWriters([]).size).toBe(0);
    expect(assignWriters([{ accountId: "u1", ownerEmail: VIEWER_EMAIL, meetings: [] }]).size).toBe(0);
  });
});
