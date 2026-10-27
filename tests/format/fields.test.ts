import { readFileSync } from "fs";
import { join } from "path";
import * as v from "valibot";
import { MEETING_START_FIELD } from "../../src/api/constants";
import { MeetingListSchema, type Meeting } from "../../src/api/schemas";
import { buildFields, meetingTitle } from "../../src/format/fields";
import { sanitizeTitle } from "../../src/format/paths";

function fixtureMeetings(): Meeting[] {
  const raw = JSON.parse(
    readFileSync(join(__dirname, "..", "fixtures", "schema-meetings-page.json"), "utf8"),
  ) as unknown;
  return v.parse(MeetingListSchema, raw);
}

// Meeting 1: owner@example.com, Person A and Person B (no email) attend; 1800.5 s long; two tags.
// Meeting 2: no name, no duration, no video link, no tags; attended by the owner and Person C.
const [one, two] = fixtureMeetings();

const CTX = {
  accountLabel: "Work",
  ownerEmail: "owner@example.com",
  kind: "note" as const,
  hash: "0123abcd",
};

describe("buildFields", () => {
  it("writes the full set for a note", () => {
    expect(buildFields(one, CTX)).toEqual({
      title: "Meeting 1",
      created: one[MEETING_START_FIELD],
      duration: 30,
      attendees: ["Person A", "Person B"],
      attendee_emails: ["person.a@example.com"],
      circleback_tags: ["Weekly", "Planning"],
      meeting_url: "https://meet.example.com/abc-defg-hij",
      circleback_id: "fixture-meeting-0001",
      circleback_kind: "note",
      circleback_account: "Work",
      circleback_updated: "2026-10-26T16:10:00.000Z",
      circleback_hash: "0123abcd",
      circleback_url: "https://circleback.ai/meetings/fixture-meeting-0001",
    });
  });

  it("excludes the owner from attendees", () => {
    const fields = buildFields(one, CTX);
    expect(fields.attendees).not.toContain("Owner Person");
    expect(fields.attendee_emails).not.toContain("owner@example.com");
  });

  it("excludes the owner whatever the case of the email", () => {
    const fields = buildFields(one, { ...CTX, ownerEmail: "  Owner@EXAMPLE.com " });
    expect(fields.attendees).toEqual(["Person A", "Person B"]);
    expect(fields.attendee_emails).toEqual(["person.a@example.com"]);
  });

  it("keeps everyone, including attendees with no email, when the owner's email is unknown", () => {
    const fields = buildFields(one, { ...CTX, ownerEmail: "" });
    expect(fields.attendees).toEqual(["Owner Person", "Person A", "Person B"]);
    expect(fields.attendee_emails).toEqual(["owner@example.com", "person.a@example.com"]);
  });

  it("falls back to email when an attendee has no name", () => {
    const meeting: Meeting = {
      ...one,
      attendees: [
        { profileId: 1, name: null, email: "no.name@example.com" },
        { profileId: 2, name: "  ", email: "blank.name@example.com" },
        { profileId: 3, name: "Has Name", email: null },
        { profileId: 4, name: null, email: null },
      ],
    };
    const fields = buildFields(meeting, CTX);
    expect(fields.attendees).toEqual(["no.name@example.com", "blank.name@example.com", "Has Name"]);
    expect(fields.attendee_emails).toEqual(["no.name@example.com", "blank.name@example.com"]);
  });

  it("writes circleback_url from the id and meeting_url from url", () => {
    const fields = buildFields(one, CTX);
    expect(fields.circleback_url).toBe("https://circleback.ai/meetings/fixture-meeting-0001");
    expect(fields.meeting_url).toBe("https://meet.example.com/abc-defg-hij");
  });

  it("omits meeting_url when the meeting has no video link", () => {
    expect(buildFields(two, CTX)).not.toHaveProperty("meeting_url");
    expect(buildFields({ ...one, url: "" }, CTX)).not.toHaveProperty("meeting_url");
    expect(buildFields({ ...one, url: "   " }, CTX)).not.toHaveProperty("meeting_url");
  });

  it("never includes type or circleback_first_synced", () => {
    for (const kind of ["note", "transcript", "combined"] as const) {
      const fields = buildFields(one, { ...CTX, kind, linkTo: "A.md" });
      expect(fields).not.toHaveProperty("type");
      expect(fields).not.toHaveProperty("circleback_first_synced");
    }
  });

  it("writes the duration in whole minutes, and null when there is none", () => {
    expect(buildFields({ ...one, duration: 1800.5 }, CTX).duration).toBe(30);
    expect(buildFields({ ...one, duration: 89 }, CTX).duration).toBe(1);
    expect(buildFields({ ...one, duration: 90 }, CTX).duration).toBe(2);
    expect(buildFields({ ...one, duration: 0 }, CTX).duration).toBe(0);
    expect(buildFields(two, CTX).duration).toBeNull();
  });

  it("writes tag names, and an empty list when there are none", () => {
    expect(buildFields(one, CTX).circleback_tags).toEqual(["Weekly", "Planning"]);
    expect(buildFields(two, CTX).circleback_tags).toEqual([]);
  });

  it("writes the meeting's start as created", () => {
    expect(buildFields(two, CTX).created).toBe(two[MEETING_START_FIELD]);
  });

  it("writes the machine keys from the context and the meeting", () => {
    const fields = buildFields(one, { ...CTX, kind: "combined", accountLabel: "Personal", hash: "ffffffff" });
    expect(fields).toMatchObject({
      circleback_id: "fixture-meeting-0001",
      circleback_kind: "combined",
      circleback_account: "Personal",
      circleback_updated: one.updatedAt,
      circleback_hash: "ffffffff",
    });
  });

  describe("title", () => {
    it("is the meeting's name as it is", () => {
      const raw = 'He said: "go" #1 - [a]/b';
      expect(buildFields({ ...one, name: raw }, CTX).title).toBe(raw);
    });

    it("is Untitled meeting when the name is null or blank", () => {
      expect(buildFields(two, CTX).title).toBe("Untitled meeting");
      expect(buildFields({ ...one, name: " \n\t " }, CTX).title).toBe("Untitled meeting");
    });

    it("is what meetingTitle gives, and sanitizes to the same file name as the meeting does", () => {
      for (const name of [null, "", "Plain", "A/B: C", "  padded  "]) {
        const meeting = { ...one, name };
        expect(sanitizeTitle(meetingTitle(meeting))).toBe(sanitizeTitle(meeting.name));
      }
    });
  });

  describe("kinds", () => {
    it("gives a transcript no attendees", () => {
      const fields = buildFields(one, { ...CTX, kind: "transcript" });
      expect(fields).not.toHaveProperty("attendees");
      expect(fields).not.toHaveProperty("attendee_emails");
      expect(fields).toMatchObject({ title: "Meeting 1", duration: 30, circleback_kind: "transcript" });
    });

    it("gives a combined note attendees, since it is a note", () => {
      const fields = buildFields(one, { ...CTX, kind: "combined" });
      expect(fields.attendees).toEqual(["Person A", "Person B"]);
      expect(fields.attendee_emails).toEqual(["person.a@example.com"]);
    });

    it("links a note to its transcript", () => {
      const fields = buildFields(one, { ...CTX, linkTo: "Meetings/Transcripts/2026-10-26 - Meeting 1-transcript.md" });
      expect(fields.transcript).toBe("[[Meetings/Transcripts/2026-10-26 - Meeting 1-transcript.md]]");
      expect(fields).not.toHaveProperty("note");
    });

    it("links a transcript to its note", () => {
      const fields = buildFields(one, { ...CTX, kind: "transcript", linkTo: "Meetings/Meeting 1.md" });
      expect(fields.note).toBe("[[Meetings/Meeting 1.md]]");
      expect(fields).not.toHaveProperty("transcript");
    });

    it("writes no link without linkTo", () => {
      for (const kind of ["note", "transcript", "combined"] as const) {
        const fields = buildFields(one, { ...CTX, kind });
        expect(fields).not.toHaveProperty("transcript");
        expect(fields).not.toHaveProperty("note");
      }
    });
  });
});
