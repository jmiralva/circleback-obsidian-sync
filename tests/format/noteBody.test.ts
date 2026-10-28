import { readFileSync } from "fs";
import { join } from "path";
import * as v from "valibot";
import { NOTES_HAVE_ACTION_ITEMS } from "../../src/api/constants";
import { MeetingListSchema, MeetingSchema, type ActionItem, type Meeting } from "../../src/api/schemas";
import { buildNoteBody } from "../../src/format/noteBody";

function fixtureMeetings(): Meeting[] {
  const raw = JSON.parse(
    readFileSync(join(__dirname, "..", "fixtures", "schema-meetings-page.json"), "utf8"),
  ) as unknown;
  return v.parse(MeetingListSchema, raw);
}

const [one] = fixtureMeetings();
const ALL = { includePrivateNotes: true, includeActionItems: true, includeInsights: true };
const LINK = "View in Circleback: https://circleback.ai/meetings/fixture-meeting-0001";

function action(overrides: Partial<ActionItem>): ActionItem {
  return {
    id: 1,
    title: "Send deck",
    description: "by Friday",
    assignee: { name: "Person B", email: null },
    status: "PENDING",
    ...overrides,
  };
}

/** Meeting 1, emptied of everything the body is built from, then given `overrides`. */
function bare(overrides: Partial<Meeting>): Meeting {
  return { ...one, notes: "", privateNotes: "", actionItems: [], insights: {}, ...overrides };
}

describe("buildNoteBody", () => {
  it("orders private notes, enhanced notes, action items, insights, closing line", () => {
    const meeting = bare({
      notes: "Circleback notes.",
      privateNotes: "My private note.",
      actionItems: [action({ status: "DONE" })],
      insights: { Questions: [{ insight: "What is the plan?", speaker: "Person A", timestamp: 49.15 }] },
    });
    expect(buildNoteBody(meeting, ALL)).toBe(
      [
        "## Private Notes",
        "",
        "My private note.",
        "",
        "## Enhanced Notes",
        "",
        "Circleback notes.",
        "",
        "## Action Items",
        "",
        "- Send deck (Person B): by Friday (done)",
        "",
        "## Insights",
        "",
        "### Questions",
        "",
        "- What is the plan?",
        "",
        LINK,
        "",
      ].join("\n"),
    );
  });

  it("omits private notes heading when private notes are empty", () => {
    const body = buildNoteBody(bare({ notes: "Just the notes.", privateNotes: "  \n " }), ALL);
    expect(body).toBe(`Just the notes.\n\n${LINK}\n`);
    expect(body).not.toContain("## Private Notes");
    expect(body).not.toContain("## Enhanced Notes");
  });

  it("omits private notes when they are not included", () => {
    const body = buildNoteBody(bare({ notes: "Notes.", privateNotes: "Secret." }), { ...ALL, includePrivateNotes: false });
    expect(body).toBe(`Notes.\n\n${LINK}\n`);
  });

  it("keeps private notes alone when Circleback's notes are empty", () => {
    const body = buildNoteBody(bare({ notes: null, privateNotes: "Only mine." }), ALL);
    expect(body).toBe(`## Private Notes\n\nOnly mine.\n\n${LINK}\n`);
  });

  it("formats action items as plain bullets with assignee and done marker", () => {
    const meeting = bare({
      actionItems: [
        action({ status: "DONE" }),
        action({ title: "Book room", description: "for Tuesday", assignee: { name: null, email: "pat@example.com" } }),
        action({ title: "Call back", description: "asap", assignee: null }),
        action({ title: "Blank name", description: "x", assignee: { name: " ", email: null } }),
      ],
    });
    const body = buildNoteBody(meeting, ALL);
    expect(body).toContain("- Send deck (Person B): by Friday (done)\n");
    expect(body).toContain("- Book room (pat@example.com): for Tuesday\n");
    expect(body).toContain("- Call back (unassigned): asap\n");
    expect(body).toContain("- Blank name (unassigned): x\n");
    expect(body).not.toContain("- [ ]");
    expect(body).not.toContain("- [x]");
  });

  it("drops the colon when an action item has no description", () => {
    const body = buildNoteBody(
      bare({ actionItems: [action({ description: "  " }), action({ title: "Done one", description: "", status: "DONE" })] }),
      ALL,
    );
    expect(body).toContain("- Send deck (Person B)\n");
    expect(body).toContain("- Done one (Person B) (done)\n");
    expect(body).not.toContain("Person B):");
  });

  it("keeps a multi-line description inside its bullet", () => {
    const body = buildNoteBody(bare({ actionItems: [action({ description: "first line\nsecond line" })] }), ALL);
    expect(body).toContain("- Send deck (Person B): first line\n  second line\n");
  });

  it("adds action items even when the notes have a heading of that name", () => {
    // Circleback's notes never carry an action items section (the API probe found none), so
    // an "Action Items" heading in them is the meeting's own topic and does not stop the
    // plugin's section. Meeting 1's hand-written notes end with "#### Action Items".
    expect(NOTES_HAVE_ACTION_ITEMS.test(one.notes ?? "")).toBe(false);
    const body = buildNoteBody(one, ALL);
    expect(body).toContain("#### Action Items\n* Person A to ut enim ad minim veniam.");
    expect(body).toContain("\n## Action Items\n\n- ");
  });

  it("adds action items to real (scrubbed) Circleback notes", () => {
    const raw = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "meeting.json"), "utf8")) as unknown;
    const real = v.parse(MeetingSchema, raw);
    expect(real.notes).toMatch(/^#### Overview\n/);
    expect(real.actionItems.length).toBeGreaterThan(0);
    const body = buildNoteBody(real, ALL);
    expect(body).toContain(`\n## Action Items\n\n- ${real.actionItems[0].title.trim()}`);
  });

  it("omits action items when they are not included or there are none", () => {
    const withItems = bare({ notes: "N", actionItems: [action({})] });
    expect(buildNoteBody(withItems, { ...ALL, includeActionItems: false })).not.toContain("Action Items");
    expect(buildNoteBody(bare({ notes: "N" }), ALL)).not.toContain("Action Items");
  });

  it("writes an insights heading per insight with one bullet per entry", () => {
    const meeting = bare({
      insights: {
        Questions: [
          { insight: "First?", speaker: null, timestamp: null },
          { insight: "  Second?  ", speaker: "Person A", timestamp: 3 },
        ],
        Risks: [{ insight: "Slipping schedule", speaker: null, timestamp: null }],
      },
    });
    const body = buildNoteBody(meeting, ALL);
    expect(body).toContain("## Insights\n\n### Questions\n\n- First?\n- Second?\n\n### Risks\n\n- Slipping schedule\n\n" + LINK);
  });

  it("renders an object-valued insight as key: value pairs and leaves out empty values", () => {
    const body = buildNoteBody(one, { ...ALL, includeActionItems: false });
    expect(body).toContain(
      "### Customer details\n\n- Company name: Example Co, Number of employees: 120, Is customer: true\n",
    );
    expect(body).not.toContain("[object Object]");
    expect(body).not.toContain("null");
  });

  it("leaves out insights with no entries and an entry with nothing in it", () => {
    const meeting = bare({
      insights: {
        Empty: [],
        Hollow: [{ insight: { Notes: null, Other: "" }, speaker: null, timestamp: null }],
      },
    });
    const body = buildNoteBody(meeting, ALL);
    expect(body).not.toContain("Insights");
    expect(body).toBe(`${LINK}\n`);
  });

  it("omits insights when they are not included", () => {
    const body = buildNoteBody(one, { ...ALL, includeInsights: false });
    expect(body).not.toContain("## Insights");
  });

  it("ends with the Circleback link built from the id", () => {
    expect(buildNoteBody(one, ALL).endsWith(`\n\n${LINK}\n`)).toBe(true);
    expect(buildNoteBody({ ...one, id: "other-id" }, ALL).endsWith("https://circleback.ai/meetings/other-id\n")).toBe(true);
  });

  it("still gives the closing line for a meeting with nothing else", () => {
    expect(buildNoteBody(bare({ notes: null }), ALL)).toBe(`${LINK}\n`);
  });

  it("trims the whitespace around each piece", () => {
    const body = buildNoteBody(bare({ notes: "\n\n  Notes here.  \n\n", privateNotes: " \n Mine \n" }), ALL);
    expect(body).toBe(`## Private Notes\n\nMine\n\n## Enhanced Notes\n\nNotes here.\n\n${LINK}\n`);
  });
});
