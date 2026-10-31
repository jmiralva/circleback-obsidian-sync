import { readFileSync } from "fs";
import { join } from "path";
import { moment } from "obsidian";
import * as v from "valibot";
import type { TFile } from "obsidian";
import { MEETING_START_FIELD } from "../../src/api/constants";
import { MeetingListSchema, type Meeting } from "../../src/api/schemas";
import { DEFAULT_SETTINGS, type CirclebackSyncSettings } from "../../src/settings/types";
import { logger } from "../../src/util/logger";
import { DailyNotes, getDailyNote, readDailyNoteConfig, shouldCreate } from "../../src/vault/dailyNotes";
import { MeetingIndex } from "../../src/vault/meetingIndex";
import { createFakeApp, type FakeApp } from "../harness/fakeApp";
import { pluginFile } from "./meetingFile";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, "..", "fixtures", name), "utf8")) as unknown;
}

// Meeting 1 starts 2026-10-26T15:00Z, which is 10:00 on Monday 2026-10-26 in Chicago.
const [ONE] = v.parse(MeetingListSchema, fixture("schema-meetings-page.json"));
const NOTE_PATH = "Meetings/Circleback/Meeting 1.md";
const LINK = "[[Meetings/Circleback/Meeting 1|Meeting 1]]";

// 12:34 on Tuesday 2026-10-27 in Chicago.
const NOW = moment.utc("2026-10-27T17:34:00Z").local();

const COMMUNITY_PLUGINS = ".obsidian/community-plugins.json";
const PERIODIC_NOTES = ".obsidian/plugins/periodic-notes/data.json";
const CORE_DAILY_NOTES = ".obsidian/daily-notes.json";

const TEMPLATE_PATH = "_templates/Daily Note Template.md";
const TEMPLATE = [
  "# {{date}}",
  "",
  "## Meetings",
  "",
  "## Notes",
  'Templater: <% tp.date.now("YYYY-MM-DD") %> and <%* tR += tp.file.title %>',
  "Day: {{date:dddd}} / {{date:YYYY/MM}} / {{title}}",
  "Time: {{time}}",
  "Left alone: {{yesterday}} {{time:HH}} {{foo}}",
  "",
].join("\n");

/** The relevant parts of Jorge's vault: Periodic Notes in charge, and a core Daily Notes file that says the same. */
const JORGE: Record<string, string> = {
  [COMMUNITY_PLUGINS]: JSON.stringify(["dataview", "periodic-notes"]),
  [PERIODIC_NOTES]: JSON.stringify({
    daily: { format: "YYYY-MM-DD", folder: "0-periodic/daily", template: TEMPLATE_PATH, enabled: true },
    weekly: { format: "gggg-[W]ww", folder: "0-periodic/weekly", template: "", enabled: false },
  }),
  [CORE_DAILY_NOTES]: JSON.stringify({ folder: "0-periodic/daily", template: "_templates/Daily Note Template", format: "YYYY-MM-DD" }),
  [TEMPLATE_PATH]: TEMPLATE,
};

function settings(changes: Partial<CirclebackSyncSettings> = {}): CirclebackSyncSettings {
  return {
    ...DEFAULT_SETTINGS,
    linkFromDailyNotes: true,
    dailyNoteLinkHeading: "## Meetings",
    dailyNoteSectionHeading: "# Circleback notes",
    ...changes,
  };
}

function meeting(changes: Partial<Meeting> = {}): Meeting {
  return { ...ONE, ...changes };
}

/** Meeting 1, starting at the given instant. */
function at(iso: string, changes: Partial<Meeting> = {}): Meeting {
  return meeting({ [MEETING_START_FIELD]: iso, ...changes });
}

const START = ONE[MEETING_START_FIELD];

function app(files: Record<string, string> = {}, unindexed: string[] = []): FakeApp {
  return createFakeApp({ files: { ...JORGE, [NOTE_PATH]: pluginFile({ id: ONE.id }), ...files }, unindexed });
}

function file(fake: FakeApp, path: string): TFile {
  const found = fake.vault.getFileByPath(path);
  if (!found) throw new Error(`No such file: ${path}`);
  return found;
}

const DAY_26 = "0-periodic/daily/2026-10-26.md";
const DAY_27 = "0-periodic/daily/2026-10-27.md";

describe("readDailyNoteConfig", () => {
  it("reads periodic notes config before core daily notes", async () => {
    expect(await readDailyNoteConfig(app())).toEqual({
      folder: "0-periodic/daily",
      format: "YYYY-MM-DD",
      template: TEMPLATE_PATH,
    });
  });

  it("prefers periodic notes even when core daily notes says something else", async () => {
    const fake = app({ [CORE_DAILY_NOTES]: JSON.stringify({ folder: "core", format: "YYYYMMDD", template: "core-template" }) });
    expect(await readDailyNoteConfig(fake)).toEqual({ folder: "0-periodic/daily", format: "YYYY-MM-DD", template: TEMPLATE_PATH });
  });

  it.each([
    ["is not in the list of enabled plugins", { [COMMUNITY_PLUGINS]: JSON.stringify(["dataview"]) }],
    ["is not listed at all", { [COMMUNITY_PLUGINS]: "[]" }],
    [
      "has its daily notes switched off",
      { [PERIODIC_NOTES]: JSON.stringify({ daily: { format: "D", folder: "periodic", template: "", enabled: false } }) },
    ],
    ["has no enabled flag", { [PERIODIC_NOTES]: JSON.stringify({ daily: { format: "D", folder: "periodic", template: "" } }) }],
    ["has no daily settings", { [PERIODIC_NOTES]: JSON.stringify({ weekly: { enabled: true } }) }],
  ])("uses core daily notes when periodic notes %s", async (_name, changes) => {
    const fake = app({ [CORE_DAILY_NOTES]: JSON.stringify({ folder: "core", format: "YYYYMMDD", template: "core-template" }), ...changes });
    expect(await readDailyNoteConfig(fake)).toEqual({ folder: "core", format: "YYYYMMDD", template: "core-template" });
  });

  it("uses core daily notes when there is no list of enabled plugins", async () => {
    const files = { ...JORGE };
    delete files[COMMUNITY_PLUGINS];
    const fake = createFakeApp({ files: { ...files, [CORE_DAILY_NOTES]: JSON.stringify({ folder: "core" }) } });
    expect(await readDailyNoteConfig(fake)).toEqual({ folder: "core", format: "YYYY-MM-DD", template: "" });
  });

  it("falls back to the defaults when neither exists", async () => {
    expect(await readDailyNoteConfig(createFakeApp())).toEqual({ folder: "", format: "YYYY-MM-DD", template: "" });
  });

  it("falls back to a default for each missing, empty, or wrongly typed field", async () => {
    const fake = createFakeApp({
      files: { [CORE_DAILY_NOTES]: JSON.stringify({ folder: "  daily  ", format: "", template: 42 }) },
    });
    expect(await readDailyNoteConfig(fake)).toEqual({ folder: "daily", format: "YYYY-MM-DD", template: "" });

    const periodic = createFakeApp({
      files: {
        [COMMUNITY_PLUGINS]: JSON.stringify(["periodic-notes"]),
        [PERIODIC_NOTES]: JSON.stringify({ daily: { enabled: true, folder: "p" } }),
      },
    });
    expect(await readDailyNoteConfig(periodic)).toEqual({ folder: "p", format: "YYYY-MM-DD", template: "" });
  });

  it("falls back to the defaults, with a warning, when core daily notes is not valid JSON", async () => {
    const fake = createFakeApp({ files: { [CORE_DAILY_NOTES]: "{ not json" } });
    expect(await readDailyNoteConfig(fake)).toEqual({ folder: "", format: "YYYY-MM-DD", template: "" });
    expect(logger.dump()).toContain("daily-notes.json");
  });

  it("goes on to core daily notes, with a warning, when periodic notes is not valid JSON", async () => {
    const fake = app({ [PERIODIC_NOTES]: "{ not json", [CORE_DAILY_NOTES]: JSON.stringify({ folder: "core" }) });
    expect(await readDailyNoteConfig(fake)).toEqual({ folder: "core", format: "YYYY-MM-DD", template: "" });
    expect(logger.dump()).toContain("periodic-notes/data.json");
  });

  it("treats a list of enabled plugins that is not valid as empty", async () => {
    const fake = app({ [COMMUNITY_PLUGINS]: '{"oops": true}', [CORE_DAILY_NOTES]: JSON.stringify({ folder: "core" }) });
    expect((await readDailyNoteConfig(fake)).folder).toBe("core");
  });
});

describe("shouldCreate", () => {
  const today = moment.utc("2026-10-27T18:00:00Z").local();
  const yesterday = moment.utc("2026-10-26T15:00:00Z").local();
  // 23:30 on the 27th in Chicago, already the 28th in UTC.
  const lateTonight = moment.utc("2026-10-28T04:30:00Z").local();

  it("always creates for always, never for never", () => {
    expect(shouldCreate("always", yesterday, NOW)).toBe(true);
    expect(shouldCreate("never", today, NOW)).toBe(false);
  });

  it("creates for today only on the day it is", () => {
    expect(shouldCreate("today", today, NOW)).toBe(true);
    expect(shouldCreate("today", lateTonight, NOW)).toBe(true);
    expect(shouldCreate("today", yesterday, NOW)).toBe(false);
  });

  it("compares local days, not UTC days", () => {
    // 2026-10-28T04:30Z is the 28th in UTC but the 27th, "today", for the person.
    expect(shouldCreate("today", moment.utc("2026-10-28T04:30:00Z"), NOW)).toBe(true);
    expect(shouldCreate("today", moment.utc("2026-10-27T17:00:00Z"), moment.utc("2026-10-28T04:30:00Z").local())).toBe(true);
  });
});

describe("getDailyNote", () => {
  const monday = moment.utc("2026-10-26T15:00:00Z").local();

  it("returns the existing note, whether or not it may create one", async () => {
    const fake = app({ [DAY_26]: "existing\n" });
    expect((await getDailyNote(fake, monday, false))?.path).toBe(DAY_26);
    expect((await getDailyNote(fake, monday, true))?.path).toBe(DAY_26);
    expect(fake.fileText(DAY_26)).toBe("existing\n");
  });

  it("returns null for a missing note it may not create", async () => {
    const fake = app();
    expect(await getDailyNote(fake, monday, false)).toBeNull();
    expect(fake.exists(DAY_26)).toBe(false);
  });

  it("creates a missing note from the template with {{date}} replaced and Templater tags left as-is", async () => {
    const fake = app();
    const created = await getDailyNote(fake, monday, true, NOW);
    expect(created?.path).toBe(DAY_26);
    expect(fake.fileText(DAY_26)).toBe(
      [
        "# 2026-10-26",
        "",
        "## Meetings",
        "",
        "## Notes",
        'Templater: <% tp.date.now("YYYY-MM-DD") %> and <%* tR += tp.file.title %>',
        "Day: Monday / 2026/10 / 2026-10-26",
        "Time: 12:34",
        "Left alone: {{yesterday}} {{time:HH}} {{foo}}",
        "",
      ].join("\n"),
    );
  });

  it("reads a template given without .md, as core daily notes writes it", async () => {
    const fake = app({
      [PERIODIC_NOTES]: JSON.stringify({ daily: { enabled: true, folder: "0-periodic/daily", template: "_templates/Daily Note Template" } }),
    });
    await getDailyNote(fake, monday, true, NOW);
    expect(fake.fileText(DAY_26).startsWith("# 2026-10-26\n")).toBe(true);
  });

  it("accepts the token spellings core daily notes accepts", async () => {
    const fake = app({ [TEMPLATE_PATH]: "{{ date }}|{{DATE:YYYY}}|{{ Date : MMM D }}|{{TITLE}}|{{ time }}" });
    await getDailyNote(fake, monday, true, NOW);
    expect(fake.fileText(DAY_26)).toBe("2026-10-26|2026|Oct 26|2026-10-26|12:34");
  });

  it("uses the daily note format for a {{date:}} with a blank format", async () => {
    const fake = app({ [TEMPLATE_PATH]: "{{date: }}" });
    await getDailyNote(fake, monday, true, NOW);
    expect(fake.fileText(DAY_26)).toBe("2026-10-26");
  });

  it("creates missing folders", async () => {
    const fake = app();
    expect(fake.exists("0-periodic")).toBe(false);
    await getDailyNote(fake, monday, true, NOW);
    expect(fake.exists("0-periodic/daily")).toBe(true);
  });

  it("puts the note in a folder the date format asks for", async () => {
    const fake = app({
      [PERIODIC_NOTES]: JSON.stringify({ daily: { enabled: true, folder: "Journal/", format: "YYYY/MM/DD dddd", template: "" } }),
    });
    const created = await getDailyNote(fake, monday, true, NOW);
    expect(created?.path).toBe("Journal/2026/10/26 Monday.md");
    expect(fake.fileText("Journal/2026/10/26 Monday.md")).toBe("");
  });

  it("puts the note at the vault root when no folder is set", async () => {
    const fake = createFakeApp();
    const created = await getDailyNote(fake, monday, true, NOW);
    expect(created?.path).toBe("2026-10-26.md");
  });

  it("makes the note empty, with a warning, when the template file is missing", async () => {
    const fake = app({ [PERIODIC_NOTES]: JSON.stringify({ daily: { enabled: true, folder: "d", template: "gone/Template.md" } }) });
    await getDailyNote(fake, monday, true, NOW);
    expect(fake.fileText("d/2026-10-26.md")).toBe("");
    expect(logger.dump()).toContain("gone/Template.md");
  });

  it("makes the note empty, without a warning, when no template is set", async () => {
    const before = logger.dump();
    const fake = createFakeApp({ files: { [CORE_DAILY_NOTES]: JSON.stringify({ folder: "d" }) } });
    await getDailyNote(fake, monday, true, NOW);
    expect(fake.fileText("d/2026-10-26.md")).toBe("");
    expect(logger.dump()).toBe(before);
  });
});

describe("DailyNotes.linkMeeting", () => {
  it("creates the day's note and links the meeting under the heading", async () => {
    const fake = app();
    await new DailyNotes(fake).linkMeeting(file(fake, NOTE_PATH), meeting(), null, settings(), NOW);
    const text = fake.fileText(DAY_26);
    expect(text).toContain(`## Meetings\n- 10:00 - ${LINK}\n\n## Notes\n`);
    expect(text.startsWith("# 2026-10-26\n")).toBe(true);
  });

  it("links a midnight meeting on the local date", async () => {
    const fake = app();
    const late = at("2026-10-28T04:30:00.000Z");
    await new DailyNotes(fake).linkMeeting(file(fake, NOTE_PATH), late, null, settings(), NOW);
    expect(fake.exists("0-periodic/daily/2026-10-28.md")).toBe(false);
    expect(fake.fileText(DAY_27)).toContain(`- 23:30 - ${LINK}`);
  });

  it("uses the local time across a DST change", async () => {
    // Clocks went back on 2026-11-01 at 02:00 CDT (07:00Z). A fixed UTC-5 offset would call these 02:30 and 03:30.
    const fake = app({
      "Meetings/Circleback/A.md": pluginFile({ id: "dst-a" }),
      "Meetings/Circleback/B.md": pluginFile({ id: "dst-b" }),
    });
    const dailyNotes = new DailyNotes(fake);
    const a = at("2026-11-01T07:30:00.000Z", { id: "dst-a", name: "A" });
    const b = at("2026-11-01T08:30:00.000Z", { id: "dst-b", name: "B" });
    await dailyNotes.linkMeeting(file(fake, "Meetings/Circleback/A.md"), a, null, settings(), NOW);
    await dailyNotes.linkMeeting(file(fake, "Meetings/Circleback/B.md"), b, null, settings(), NOW);
    const text = fake.fileText("0-periodic/daily/2026-11-01.md");
    expect(text).toContain("## Meetings\n- 01:30 - [[Meetings/Circleback/A|A]]\n- 02:30 - [[Meetings/Circleback/B|B]]\n");
  });

  it("does nothing when linking from daily notes is off", async () => {
    const fake = app();
    await new DailyNotes(fake).linkMeeting(file(fake, NOTE_PATH), meeting(), null, settings({ linkFromDailyNotes: false }), NOW);
    expect(fake.exists(DAY_26)).toBe(false);
  });

  it("writes through vault.process, and only when the text changed", async () => {
    const fake = app({ [DAY_26]: "# Day\n\n## Meetings\n- 09:00 - [[Meetings/Granola/x|x]]\n" });
    const process = jest.spyOn(fake.vault, "process");
    const dailyNotes = new DailyNotes(fake);
    await dailyNotes.linkMeeting(file(fake, NOTE_PATH), meeting(), null, settings(), NOW);
    expect(process).toHaveBeenCalledTimes(1);
    expect(fake.fileText(DAY_26)).toBe(`# Day\n\n## Meetings\n- 09:00 - [[Meetings/Granola/x|x]]\n- 10:00 - ${LINK}\n`);

    await dailyNotes.linkMeeting(file(fake, NOTE_PATH), meeting(), null, settings(), NOW);
    expect(process).toHaveBeenCalledTimes(1);
  });

  it("keeps hand-typed lines, old Granola lines, and an edited line for the same meeting", async () => {
    const edited = `- 10:00 - ${LINK} (moved to 10:30)`;
    const text = ["# Day", "", "## Meetings", "- 09:00 - [[Meetings/Granola/x|x]]", "- note to self", edited, "", "## Notes", "mine", ""].join("\n");
    const fake = app({ [DAY_26]: text });
    await new DailyNotes(fake).linkMeeting(file(fake, NOTE_PATH), meeting(), null, settings(), NOW);
    expect(fake.fileText(DAY_26)).toBe(text);
  });

  it("recognizes its line by the meeting it links to, not by the text of the link", async () => {
    const fake = app();
    const dailyNotes = new DailyNotes(fake);
    const note = file(fake, NOTE_PATH);
    await dailyNotes.linkMeeting(note, meeting(), null, settings(), NOW);

    // Obsidian rewrites links when a note is renamed, and may write them in their shortest form.
    await fake.fileManager.renameFile(note, "Meetings/Circleback/2026-10-26 - Meeting 1.md");
    const daily = file(fake, DAY_26);
    await fake.vault.modify(daily, fake.fileText(DAY_26).replace("Meetings/Circleback/Meeting 1", "2026-10-26 - Meeting 1"));
    const rewritten = fake.fileText(DAY_26);

    await dailyNotes.linkMeeting(note, meeting(), null, settings(), NOW);
    expect(fake.fileText(DAY_26)).toBe(rewritten);
    expect(rewritten.match(/- 10:00 - /g)).toHaveLength(1);
  });

  it("finds its line through the meeting index when the metadata cache has not seen the note yet", async () => {
    const fake = app({}, [NOTE_PATH]);
    const note = file(fake, NOTE_PATH);
    expect(fake.metadataCache.getFileCache(note)).toBeNull();

    const index = new MeetingIndex(fake, () => [""]);
    index.upsert(note, { circleback_id: ONE.id, circleback_kind: "note" });
    const dailyNotes = new DailyNotes(fake, index);

    await dailyNotes.linkMeeting(note, meeting(), null, settings(), NOW);
    const first = fake.fileText(DAY_26);
    expect(first).toContain(`- 10:00 - ${LINK}`);
    await dailyNotes.linkMeeting(note, meeting(), null, settings(), NOW);
    expect(fake.fileText(DAY_26)).toBe(first);
  });

  it("does not count a link to a note with another meeting's id", async () => {
    const other = "- 10:00 - [[Meetings/Circleback/Other|Meeting 1]]";
    const fake = app({
      "Meetings/Circleback/Other.md": pluginFile({ id: "other" }),
      [DAY_26]: `# Day\n\n## Meetings\n${other}\n`,
    });
    await new DailyNotes(fake).linkMeeting(file(fake, NOTE_PATH), meeting(), null, settings(), NOW);
    expect(fake.fileText(DAY_26)).toBe(`# Day\n\n## Meetings\n${other}\n- 10:00 - ${LINK}\n`);
  });

  it("points its own line at the note being linked when the line links to a copy moved out of the sync folder", async () => {
    const moved = "- 10:00 - [[Archive/Meeting 1|Meeting 1]]";
    const fake = app({
      "Archive/Meeting 1.md": pluginFile({ id: ONE.id }),
      [DAY_26]: `# Day\n\n## Meetings\n- 09:00 - standup\n${moved}\n- 11:00 - lunch\n`,
    });
    await new DailyNotes(fake).linkMeeting(file(fake, NOTE_PATH), meeting(), null, settings(), NOW);
    expect(fake.fileText(DAY_26)).toBe(`# Day\n\n## Meetings\n- 09:00 - standup\n- 10:00 - ${LINK}\n- 11:00 - lunch\n`);
  });

  it("leaves an edited line that links to a copy moved out of the sync folder, and adds no second line", async () => {
    const text = "# Day\n\n## Meetings\n- 10:00 - [[Archive/Meeting 1|Meeting 1]] (filed)\n";
    const fake = app({ "Archive/Meeting 1.md": pluginFile({ id: ONE.id }), [DAY_26]: text });
    await new DailyNotes(fake).linkMeeting(file(fake, NOTE_PATH), meeting(), null, settings(), NOW);
    expect(fake.fileText(DAY_26)).toBe(text);
  });

  it("writes an alias that cannot break the link", async () => {
    const fake = app();
    await new DailyNotes(fake).linkMeeting(file(fake, NOTE_PATH), meeting({ name: "Q3 [draft] | review\nfinal" }), null, settings(), NOW);
    expect(fake.fileText(DAY_26)).toContain("- 10:00 - [[Meetings/Circleback/Meeting 1|Q3 [draft_ _ review final]]");
  });

  it("uses the fallback title for a meeting with no name", async () => {
    const fake = app();
    await new DailyNotes(fake).linkMeeting(file(fake, NOTE_PATH), meeting({ name: null }), null, settings(), NOW);
    expect(fake.fileText(DAY_26)).toContain("|Untitled meeting]]");
  });

  it("creates the heading in a note that lacks it", async () => {
    const fake = app({ [DAY_26]: "# Day\n\nSome text\n" });
    await new DailyNotes(fake).linkMeeting(file(fake, NOTE_PATH), meeting(), null, settings(), NOW);
    expect(fake.fileText(DAY_26)).toBe(`# Day\n\nSome text\n\n## Meetings\n- 10:00 - ${LINK}\n`);
  });

  it("does nothing, with a warning, when the heading setting is empty", async () => {
    const fake = app({ [DAY_26]: "# Day\n" });
    await new DailyNotes(fake).linkMeeting(file(fake, NOTE_PATH), meeting(), null, settings({ dailyNoteLinkHeading: " " }), NOW);
    expect(fake.fileText(DAY_26)).toBe("# Day\n");
    expect(logger.dump()).toContain("daily note link heading");
  });

  it("does nothing, with a warning, for a start time it cannot read", async () => {
    const fake = app();
    await new DailyNotes(fake).linkMeeting(file(fake, NOTE_PATH), at("not a date"), null, settings(), NOW);
    expect(fake.exists("0-periodic")).toBe(false);
  });

  describe("create missing daily notes", () => {
    it("creates today's note and not an earlier one with 'today'", async () => {
      const fake = app();
      const dailyNotes = new DailyNotes(fake);
      const note = file(fake, NOTE_PATH);
      await dailyNotes.linkMeeting(note, meeting(), null, settings({ createMissingDailyNotes: "today" }), NOW);
      expect(fake.exists(DAY_26)).toBe(false);

      const today = at("2026-10-27T15:00:00.000Z");
      await dailyNotes.linkMeeting(note, today, null, settings({ createMissingDailyNotes: "today" }), NOW);
      expect(fake.fileText(DAY_27)).toContain(`- 10:00 - ${LINK}`);
    });

    it("never creates a note with 'never'", async () => {
      const fake = app();
      const dailyNotes = new DailyNotes(fake);
      await dailyNotes.linkMeeting(file(fake, NOTE_PATH), at("2026-10-27T15:00:00.000Z"), null, settings({ createMissingDailyNotes: "never" }), NOW);
      expect(fake.exists("0-periodic")).toBe(false);
    });

    it("still adds to a note that exists, whatever the setting", async () => {
      const fake = app({ [DAY_26]: "# Day\n" });
      await new DailyNotes(fake).linkMeeting(file(fake, NOTE_PATH), meeting(), null, settings({ createMissingDailyNotes: "never" }), NOW);
      expect(fake.fileText(DAY_26)).toBe(`# Day\n\n## Meetings\n- 10:00 - ${LINK}\n`);
    });
  });

  describe("when the meeting date changes", () => {
    const moved = at("2026-10-27T15:00:00.000Z");

    it("moves the line", async () => {
      const fake = app();
      const dailyNotes = new DailyNotes(fake);
      const note = file(fake, NOTE_PATH);
      await dailyNotes.linkMeeting(note, meeting(), null, settings(), NOW);
      expect(fake.fileText(DAY_26)).toContain(LINK);

      await dailyNotes.linkMeeting(note, moved, START, settings(), NOW);
      expect(fake.fileText(DAY_26)).not.toContain(LINK);
      expect(fake.fileText(DAY_27)).toContain(`- 10:00 - ${LINK}`);
      // The old day's note and heading stay; only the plugin's line went.
      expect(fake.fileText(DAY_26)).toContain("## Meetings\n\n## Notes");
    });

    it("removes only its own line from the old day", async () => {
      const edited = `- 10:00 - ${LINK} (kept)`;
      const text = ["# Day", "## Meetings", "- 09:00 - [[Meetings/Granola/x|x]]", `- 10:00 - ${LINK}`, "- note to self", edited, ""].join("\n");
      const fake = app({ [DAY_26]: text });
      await new DailyNotes(fake).linkMeeting(file(fake, NOTE_PATH), moved, START, settings(), NOW);
      expect(fake.fileText(DAY_26)).toBe(["# Day", "## Meetings", "- 09:00 - [[Meetings/Granola/x|x]]", "- note to self", edited, ""].join("\n"));
    });

    it("keeps a line whose alias the user changed", async () => {
      const mine = `- 10:00 - [[Meetings/Circleback/Meeting 1|my notes on the call]]`;
      const text = ["# Day", "## Meetings", mine, ""].join("\n");
      const fake = app({ [DAY_26]: text });
      await new DailyNotes(fake).linkMeeting(file(fake, NOTE_PATH), moved, START, settings(), NOW);
      expect(fake.fileText(DAY_26)).toBe(text);
      expect(fake.fileText(DAY_27)).toContain(`- 10:00 - ${LINK}`);
    });

    it("leaves a line written under the old title when the meeting was renamed in the same run", async () => {
      const stale = "- 10:00 - [[Meetings/Circleback/Meeting 1|Old title]]";
      const text = ["# Day", "## Meetings", stale, ""].join("\n");
      const fake = app({ [DAY_26]: text });
      await new DailyNotes(fake).linkMeeting(file(fake, NOTE_PATH), { ...moved, name: "New title" }, START, settings(), NOW);
      expect(fake.fileText(DAY_26)).toBe(text);
      expect(fake.fileText(DAY_27)).toContain("- 10:00 - [[Meetings/Circleback/Meeting 1|New title]]");
    });

    it("keeps the old line when adding to the new day fails, and a retry finishes the move", async () => {
      const fake = app();
      const dailyNotes = new DailyNotes(fake);
      const note = file(fake, NOTE_PATH);
      await dailyNotes.linkMeeting(note, meeting(), null, settings(), NOW);

      const realProcess = fake.vault.process.bind(fake.vault);
      const failing = jest.spyOn(fake.vault, "process").mockImplementation(async (target, change) => {
        if (target.path === DAY_27) throw new Error("disk full");
        return realProcess(target, change);
      });
      await expect(dailyNotes.linkMeeting(note, moved, START, settings(), NOW)).rejects.toThrow("disk full");
      expect(fake.fileText(DAY_26)).toContain(`- 10:00 - ${LINK}`);
      expect(fake.fileText(DAY_27)).not.toContain(LINK);

      failing.mockRestore();
      await dailyNotes.linkMeeting(note, moved, START, settings(), NOW);
      expect(fake.fileText(DAY_26)).not.toContain(LINK);
      expect(fake.fileText(DAY_27)).toContain(`- 10:00 - ${LINK}`);
    });

    it("keeps the line when both days are in one note, as with a monthly note", async () => {
      const monthly = {
        [PERIODIC_NOTES]: JSON.stringify({ daily: { enabled: true, folder: "d", format: "YYYY-MM", template: "" } }),
      };
      const fake = app(monthly);
      const dailyNotes = new DailyNotes(fake);
      const note = file(fake, NOTE_PATH);
      await dailyNotes.linkMeeting(note, meeting(), null, settings(), NOW);
      await dailyNotes.linkMeeting(note, moved, START, settings(), NOW);
      expect(fake.fileText("d/2026-10.md")).toBe(`## Meetings\n- 10:00 - ${LINK}\n`);
    });

    it("never creates the old day's note just to remove a line", async () => {
      const fake = app();
      await new DailyNotes(fake).linkMeeting(file(fake, NOTE_PATH), moved, START, settings(), NOW);
      expect(fake.exists(DAY_26)).toBe(false);
      expect(fake.fileText(DAY_27)).toContain(LINK);
    });

    it("removes the old line even when the new day's note may not be created", async () => {
      const fake = app();
      const dailyNotes = new DailyNotes(fake);
      const note = file(fake, NOTE_PATH);
      await dailyNotes.linkMeeting(note, meeting(), null, settings(), NOW);
      await dailyNotes.linkMeeting(note, moved, START, settings({ createMissingDailyNotes: "never" }), NOW);
      expect(fake.fileText(DAY_26)).not.toContain(LINK);
      expect(fake.exists(DAY_27)).toBe(false);
    });

    it("moves a meeting that slipped past midnight by local time, not UTC", async () => {
      // 03:00Z and 05:00Z on the 28th are the 27th at 22:00 and 00:00 on the 28th in Chicago.
      const fake = app();
      const dailyNotes = new DailyNotes(fake);
      const note = file(fake, NOTE_PATH);
      const evening = at("2026-10-28T03:00:00.000Z");
      const afterMidnight = at("2026-10-28T05:00:00.000Z");
      await dailyNotes.linkMeeting(note, evening, null, settings(), NOW);
      expect(fake.fileText(DAY_27)).toContain(`- 22:00 - ${LINK}`);

      await dailyNotes.linkMeeting(note, afterMidnight, evening[MEETING_START_FIELD], settings(), NOW);
      expect(fake.fileText(DAY_27)).not.toContain(LINK);
      expect(fake.fileText("0-periodic/daily/2026-10-28.md")).toContain(`- 00:00 - ${LINK}`);
    });

    it("leaves the line alone when only the time changed", async () => {
      const fake = app();
      const dailyNotes = new DailyNotes(fake);
      const note = file(fake, NOTE_PATH);
      await dailyNotes.linkMeeting(note, meeting(), null, settings(), NOW);
      const before = fake.fileText(DAY_26);
      await dailyNotes.linkMeeting(note, at("2026-10-26T16:30:00.000Z"), START, settings(), NOW);
      expect(fake.fileText(DAY_26)).toBe(before);
    });

    it("does nothing to an old day when linking is off", async () => {
      const fake = app({ [DAY_26]: `## Meetings\n- 10:00 - ${LINK}\n` });
      await new DailyNotes(fake).linkMeeting(file(fake, NOTE_PATH), moved, START, settings({ linkFromDailyNotes: false }), NOW);
      expect(fake.fileText(DAY_26)).toContain(LINK);
    });
  });
});

describe("DailyNotes.writeSection", () => {
  const BLOCK = "# Overview\nWe talked.\n\n## Action Items\n- Do it";

  it("writes the meeting between markers in the section of the local date's note", async () => {
    const fake = app();
    await new DailyNotes(fake).writeSection(meeting(), BLOCK, settings(), NOW);
    const text = fake.fileText(DAY_26);
    expect(text.endsWith(
      [
        "# Circleback notes",
        `%% circleback-start ${ONE.id} %%`,
        "## Meeting 1",
        "### Overview",
        "We talked.",
        "",
        "#### Action Items",
        "- Do it",
        `%% circleback-end ${ONE.id} %%`,
        "",
      ].join("\n"),
    )).toBe(true);
    expect(text.startsWith("# 2026-10-26\n")).toBe(true);
  });

  it("puts a midnight meeting in the note of its local date", async () => {
    const fake = app();
    await new DailyNotes(fake).writeSection(at("2026-10-28T04:30:00.000Z"), BLOCK, settings(), NOW);
    expect(fake.fileText(DAY_27)).toContain(`%% circleback-start ${ONE.id} %%`);
    expect(fake.exists("0-periodic/daily/2026-10-28.md")).toBe(false);
  });

  it("replaces only the block when the meeting is written again, and keeps user text", async () => {
    const fake = app();
    const dailyNotes = new DailyNotes(fake);
    await dailyNotes.writeSection(meeting(), "first", settings(), NOW);
    const daily = file(fake, DAY_26);
    await fake.vault.modify(daily, `Before it\n${fake.fileText(DAY_26)}After it\n`);

    await dailyNotes.writeSection(meeting({ name: "Renamed" }), "second", settings(), NOW);
    const text = fake.fileText(DAY_26);
    expect(text).toContain(`Before it\n# 2026-10-26`);
    expect(text).toContain(`%% circleback-start ${ONE.id} %%\n## Renamed\nsecond\n%% circleback-end ${ONE.id} %%\n`);
    expect(text).not.toContain("first");
    expect(text.endsWith("After it\n")).toBe(true);
  });

  it("writes through vault.process, and only when the text changed", async () => {
    const fake = app({ [DAY_26]: "# Day\n" });
    const process = jest.spyOn(fake.vault, "process");
    const dailyNotes = new DailyNotes(fake);
    await dailyNotes.writeSection(meeting(), "body", settings(), NOW);
    await dailyNotes.writeSection(meeting(), "body", settings(), NOW);
    expect(process).toHaveBeenCalledTimes(1);
  });

  it("says whether it changed the daily note", async () => {
    const fake = app({ [DAY_26]: "# Day\n" });
    const dailyNotes = new DailyNotes(fake);
    expect(await dailyNotes.writeSection(meeting(), "body", settings(), NOW)).toBe(true);
    expect(await dailyNotes.writeSection(meeting(), "body", settings(), NOW)).toBe(false);
    expect(await dailyNotes.writeSection(meeting(), "new body", settings(), NOW)).toBe(true);
    expect(await dailyNotes.writeSection(meeting(), "body", settings({ dailyNoteSectionHeading: "" }), NOW)).toBe(false);
    expect(await dailyNotes.writeSection(at("2026-10-20T15:00:00.000Z"), "body", settings({ createMissingDailyNotes: "never" }), NOW)).toBe(false);
  });

  it("does not need link-from-daily-notes to be on", async () => {
    const fake = app();
    await new DailyNotes(fake).writeSection(meeting(), "body", settings({ linkFromDailyNotes: false }), NOW);
    expect(fake.fileText(DAY_26)).toContain(`%% circleback-start ${ONE.id} %%`);
  });

  it("follows the create rule for missing notes", async () => {
    const fake = app();
    const dailyNotes = new DailyNotes(fake);
    await dailyNotes.writeSection(meeting(), "body", settings({ createMissingDailyNotes: "never" }), NOW);
    await dailyNotes.writeSection(meeting(), "body", settings({ createMissingDailyNotes: "today" }), NOW);
    expect(fake.exists(DAY_26)).toBe(false);

    await dailyNotes.writeSection(at("2026-10-27T15:00:00.000Z"), "body", settings({ createMissingDailyNotes: "today" }), NOW);
    expect(fake.exists(DAY_27)).toBe(true);
  });

  it("uses the section heading setting", async () => {
    const fake = app({ [DAY_26]: "# Day\n\n### Calls\nmine\n" });
    await new DailyNotes(fake).writeSection(meeting(), "body", settings({ dailyNoteSectionHeading: "### Calls" }), NOW);
    expect(fake.fileText(DAY_26)).toBe(
      `# Day\n\n### Calls\nmine\n\n%% circleback-start ${ONE.id} %%\n#### Meeting 1\nbody\n%% circleback-end ${ONE.id} %%\n`,
    );
  });

  it("does nothing, with a warning, when the section heading setting is empty", async () => {
    const fake = app({ [DAY_26]: "# Day\n" });
    await new DailyNotes(fake).writeSection(meeting(), "body", settings({ dailyNoteSectionHeading: "" }), NOW);
    expect(fake.fileText(DAY_26)).toBe("# Day\n");
    expect(logger.dump()).toContain("daily note section heading");
  });
});
