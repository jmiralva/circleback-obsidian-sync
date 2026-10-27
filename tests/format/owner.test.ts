import { readFileSync } from "fs";
import { join } from "path";
import * as v from "valibot";
import { MeetingListSchema, type Meeting } from "../../src/api/schemas";
import { findOwner, ownsMeeting } from "../../src/format/owner";

function fixtureMeetings(): Meeting[] {
  const raw = JSON.parse(
    readFileSync(join(__dirname, "..", "fixtures", "schema-meetings-page.json"), "utf8"),
  ) as unknown;
  return v.parse(MeetingListSchema, raw);
}

// Meeting 1: owner@example.com is an attendee and the Owner of the meeting.
// Meeting 3: person.a@example.com is the Owner; owner@example.com is only a Viewer in
// sharedWith and is not an attendee.
const [one, , three] = fixtureMeetings();

describe("findOwner", () => {
  it("finds the owner by email in attendees then sharedWith", () => {
    expect(findOwner(one, "owner@example.com")).toEqual({ name: "Owner Person", profileId: 1 });
    // Not an attendee of meeting 3, so the sharedWith entry answers (it has no profile id).
    expect(findOwner(three, "owner@example.com")).toEqual({ name: "Owner Person" });
  });

  it("matches the email without regard to case or surrounding spaces", () => {
    expect(findOwner(one, "  OWNER@Example.COM ")).toEqual({ name: "Owner Person", profileId: 1 });
  });

  it("prefers the attendee entry over the sharedWith entry", () => {
    const meeting: Meeting = {
      ...one,
      attendees: [{ profileId: 9, name: "Attendee Name", email: "who@example.com" }],
      sharedWith: [{ name: "Shared Name", email: "who@example.com", access: "Owner" }],
    };
    expect(findOwner(meeting, "who@example.com")).toEqual({ name: "Attendee Name", profileId: 9 });
  });

  it("returns null when nobody has the email", () => {
    expect(findOwner(one, "nobody@example.com")).toBeNull();
  });

  it("returns null for an empty email instead of matching people who have none", () => {
    // Person B in meeting 1 has a null email.
    expect(findOwner(one, "")).toBeNull();
    expect(findOwner(one, "   ")).toBeNull();
  });

  it("keeps a null name as null", () => {
    const meeting: Meeting = {
      ...one,
      attendees: [{ profileId: 5, name: null, email: "owner@example.com" }],
      sharedWith: [],
    };
    expect(findOwner(meeting, "owner@example.com")).toEqual({ name: null, profileId: 5 });
  });
});

describe("ownsMeeting", () => {
  it("is true only for the Owner entry", () => {
    expect(ownsMeeting(one, "owner@example.com")).toBe(true);
    // Meeting 3 lists owner@example.com as a Viewer only.
    expect(ownsMeeting(three, "owner@example.com")).toBe(false);
    expect(ownsMeeting(three, "person.a@example.com")).toBe(true);
  });

  it("compares emails case-insensitively", () => {
    expect(ownsMeeting(one, "Owner@EXAMPLE.com")).toBe(true);
  });

  it("is false for an empty email, even when the Owner entry has none", () => {
    const meeting: Meeting = { ...one, sharedWith: [{ name: "Team", access: "Owner" }] };
    expect(ownsMeeting(meeting, "")).toBe(false);
    expect(ownsMeeting(meeting, "owner@example.com")).toBe(false);
  });
});
