import { readFileSync } from "fs";
import { join } from "path";
import * as v from "valibot";
import type { TFile } from "obsidian";
import { MeetingListSchema, TranscriptSchema, type Meeting } from "../../src/api/schemas";
import { buildFields } from "../../src/format/fields";
import { buildNoteBody } from "../../src/format/noteBody";
import { buildTranscriptBody } from "../../src/format/transcript";
import { DEFAULT_SETTINGS, type CirclebackSyncSettings } from "../../src/settings/types";
import { hashBody } from "../../src/util/hash";
import { splitFrontmatter } from "../../src/vault/frontmatter";
import { MeetingIndex } from "../../src/vault/meetingIndex";
import { NoteWriter, type WriteContext } from "../../src/vault/noteWriter";
import { createFakeApp, type FakeApp } from "../harness/fakeApp";
import { fileText } from "./meetingFile";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, "..", "fixtures", name), "utf8")) as unknown;
}

// Meeting 1 starts 2026-10-26T15:00Z (10:00 in Chicago), was last updated 16:10Z, has a video
// link, and is attended by the owner (owner@example.com), Person A and Person B.
const [ONE] = v.parse(MeetingListSchema, fixture("schema-meetings-page.json"));
// Person A, then the owner ("Owner Person"), then a speaker-less segment, Person B, Person A.
const SEGMENTS = v.parse(TranscriptSchema, fixture("schema-transcript.json"));

const NOTE = "Circleback/Meeting 1.md";
const TRANSCRIPT = "Circleback/Transcripts/Meeting 1-transcript.md";
const LATER = "2026-10-27T09:00:00.000Z";
const NOW = "2026-10-27T12:00:00.000Z";
const BODY_OPTIONS = { includePrivateNotes: false, includeActionItems: true, includeInsights: true };

function meeting(changes: Partial<Meeting> = {}): Meeting {
  return { ...ONE, ...changes };
}

/** Meeting 1 as Circleback has it after a later edit. */
function edited(changes: Partial<Meeting> = {}): Meeting {
  return meeting({ updatedAt: LATER, ...changes });
}

function context(settings: Partial<CirclebackSyncSettings> = {}, changes: Partial<WriteContext> = {}): WriteContext {
  return {
    settings: { ...DEFAULT_SETTINGS, syncTranscripts: true, ...settings },
    accountLabel: "Work",
    ownerEmail: "owner@example.com",
    ownerName: "Owner Person",
    dailyFolder: "Daily",
    force: false,
    now: () => new Date(NOW),
    ...changes,
  };
}

const FORCED = context({}, { force: true });

interface Setup {
  app: FakeApp;
  index: MeetingIndex;
  writer: NoteWriter;
}

async function setup(files: Record<string, string> = {}): Promise<Setup> {
  const app = createFakeApp({ files });
  const index = new MeetingIndex(app, () => [""]);
  await index.build();
  return { app, index, writer: new NoteWriter(app, index) };
}

function file(app: FakeApp, path: string): TFile {
  const found = app.vault.getFileByPath(path);
  if (!found) throw new Error(`No such file: ${path}`);
  return found;
}

/** A file's frontmatter, parsed from its current text. */
function frontmatter(app: FakeApp, path: string): Record<string, unknown> {
  const fm = app.metadataCache.getFileCache(file(app, path))?.frontmatter;
  if (!fm) throw new Error(`No frontmatter: ${path}`);
  return fm;
}

function bodyOf(app: FakeApp, path: string): string {
  return splitFrontmatter(app.fileText(path)).body;
}

function markdownPaths(app: FakeApp): string[] {
  return app.vault
    .getMarkdownFiles()
    .map((f) => f.path)
    .sort();
}

async function addFrontmatter(app: FakeApp, path: string, fields: Record<string, unknown>): Promise<void> {
  await app.fileManager.processFrontMatter(file(app, path), (fm: Record<string, unknown>) => {
    Object.assign(fm, fields);
  });
}

async function move(app: FakeApp, from: string, to: string): Promise<void> {
  const folder = to.slice(0, to.lastIndexOf("/"));
  if (folder !== "" && !app.exists(folder)) await app.vault.createFolder(folder);
  await app.fileManager.renameFile(file(app, from), to);
}

/** Spies on every call that changes the vault. */
function watchWrites(app: FakeApp): jest.SpyInstance[] {
  return [
    jest.spyOn(app.vault, "create"),
    jest.spyOn(app.vault, "createFolder"),
    jest.spyOn(app.vault, "modify"),
    jest.spyOn(app.vault, "process"),
    jest.spyOn(app.fileManager, "processFrontMatter"),
    jest.spyOn(app.fileManager, "renameFile"),
    jest.spyOn(app.fileManager, "trashFile"),
  ];
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("NoteWriter.write", () => {
  it("creates note and transcript with cross links and type set", async () => {
    const { app, writer } = await setup();
    const result = await writer.write(ONE, SEGMENTS, context());

    expect(result.changed).toBe(true);
    expect(result.oldStart).toBeNull();
    expect(result.note?.path).toBe(NOTE);
    expect(result.transcript?.path).toBe(TRANSCRIPT);
    expect(markdownPaths(app)).toEqual([NOTE, TRANSCRIPT]);

    const note = frontmatter(app, NOTE);
    expect(note).toMatchObject({
      type: "note",
      title: "Meeting 1",
      created: "2026-10-26T15:00:00.000Z",
      attendees: ["Person A", "Person B"],
      transcript: `[[${TRANSCRIPT}]]`,
      circleback_id: "fixture-meeting-0001",
      circleback_kind: "note",
      circleback_account: "Work",
      circleback_updated: "2026-10-26T16:10:00.000Z",
      circleback_first_synced: NOW,
      circleback_url: "https://circleback.ai/meetings/fixture-meeting-0001",
    });
    expect(note).not.toHaveProperty("note");

    const transcript = frontmatter(app, TRANSCRIPT);
    expect(transcript).toMatchObject({
      type: "transcript",
      note: `[[${NOTE}]]`,
      circleback_id: "fixture-meeting-0001",
      circleback_kind: "transcript",
      circleback_first_synced: NOW,
    });
    expect(transcript).not.toHaveProperty("transcript");
    expect(transcript).not.toHaveProperty("attendees");

    expect(bodyOf(app, NOTE)).toBe(buildNoteBody(ONE, BODY_OPTIONS));
    const transcriptBody = bodyOf(app, TRANSCRIPT);
    expect(transcriptBody.startsWith("# Transcript for: Meeting 1\n\n### Person A (2026-10-26T15:00:00.500Z)\n")).toBe(true);
    expect(transcriptBody).toContain("### You (2026-10-26T15:00:09.800Z)");
    expect(transcriptBody).not.toContain("### Owner Person");
  });

  it("keeps user frontmatter on update", async () => {
    const { app, writer } = await setup();
    await writer.write(ONE, SEGMENTS, context());
    await addFrontmatter(app, NOTE, { people: ["[[Person A]]", "[[Person B]]"], enriched: "2026-10-28" });
    await addFrontmatter(app, TRANSCRIPT, { reviewed: true });

    await writer.write(edited({ notes: "#### New notes" }), SEGMENTS, FORCED);

    expect(frontmatter(app, NOTE)).toMatchObject({
      people: ["[[Person A]]", "[[Person B]]"],
      enriched: "2026-10-28",
      circleback_updated: LATER,
    });
    expect(frontmatter(app, TRANSCRIPT)).toMatchObject({ reviewed: true, circleback_updated: LATER });
    expect(bodyOf(app, NOTE)).toContain("#### New notes");
  });

  it("does not overwrite a user-edited type", async () => {
    const { app, writer } = await setup();
    await writer.write(ONE, SEGMENTS, context());
    await addFrontmatter(app, NOTE, { type: "meeting" });

    await writer.write(edited(), SEGMENTS, context({}, { force: true, now: () => new Date("2026-11-01T00:00:00.000Z") }));

    expect(frontmatter(app, NOTE).type).toBe("meeting");
    expect(frontmatter(app, NOTE).circleback_first_synced).toBe(NOW);
    expect(frontmatter(app, TRANSCRIPT).type).toBe("transcript");
  });

  it("round-trips YAML-hostile titles and names", async () => {
    const title = 'He said: "#1" - ok\nnext';
    const names = ['- Dash: "quoted" #hash', "Two\nlines", "plain: colon"];
    const hostile = meeting({
      name: title,
      tags: [{ id: 9, name: "#tag: - x" }],
      attendees: [
        { profileId: 1, name: "Owner Person", email: "owner@example.com" },
        { profileId: 2, name: names[0], email: "dash@example.com" },
        { profileId: 3, name: names[1], email: null },
        { profileId: 4, name: names[2], email: "colon@example.com" },
      ],
    });
    const { app, writer } = await setup();
    const result = await writer.write(hostile, SEGMENTS, context());

    const notePath = "Circleback/He said_ __1_ - ok next.md";
    const transcriptPath = "Circleback/Transcripts/He said_ __1_ - ok next-transcript.md";
    expect(markdownPaths(app)).toEqual([notePath, transcriptPath]);
    expect(result.note?.path).toBe(notePath);

    const note = frontmatter(app, notePath);
    expect(note.title).toBe(title);
    expect(note.attendees).toEqual(names);
    expect(note.attendee_emails).toEqual(["dash@example.com", "colon@example.com"]);
    expect(note.circleback_tags).toEqual(["#tag: - x"]);
    expect(frontmatter(app, transcriptPath).title).toBe(title);

    // Read back exactly, the previous title gives back the same path, so a rewrite stays put.
    await writer.write(edited({ name: title, attendees: hostile.attendees, tags: hostile.tags }), SEGMENTS, FORCED);
    expect(markdownPaths(app)).toEqual([notePath, transcriptPath]);
    expect(frontmatter(app, notePath).title).toBe(title);
    expect(frontmatter(app, notePath).attendees).toEqual(names);
  });

  it("leaves a moved note where it is", async () => {
    const { app, index, writer } = await setup();
    await writer.write(ONE, SEGMENTS, context());
    const note = file(app, NOTE);
    await move(app, NOTE, "Work/x.md");

    const result = await writer.write(edited({ name: "Planning sync" }), SEGMENTS, context());

    expect(result.note).toBe(note);
    expect(note.path).toBe("Work/x.md");
    expect(app.exists(NOTE)).toBe(false);
    expect(app.exists("Circleback/Planning sync.md")).toBe(false);
    expect(index.find(ONE.id, "note")).toEqual([note]);
    expect(frontmatter(app, "Work/x.md").title).toBe("Planning sync");
    // The transcript was still where the plugin put it, so it follows the new title.
    expect(markdownPaths(app)).toEqual(["Circleback/Transcripts/Planning sync-transcript.md", "Work/x.md"]);
    expect(frontmatter(app, "Circleback/Transcripts/Planning sync-transcript.md").note).toBe("[[Work/x.md]]");
  });

  it("leaves a note the user renamed in its folder alone", async () => {
    const { app, writer } = await setup();
    await writer.write(ONE, null, context());
    await move(app, NOTE, "Circleback/Kickoff with Person A.md");

    await writer.write(edited({ name: "Planning sync" }), null, context());

    expect(markdownPaths(app)).toEqual(["Circleback/Kickoff with Person A.md"]);
  });

  it("renames when the title changes and the file was not moved", async () => {
    const { app, writer } = await setup();
    await writer.write(ONE, SEGMENTS, context());
    const note = file(app, NOTE);
    const transcript = file(app, TRANSCRIPT);

    const result = await writer.write(edited({ name: "Planning sync" }), SEGMENTS, context());

    const newNote = "Circleback/Planning sync.md";
    const newTranscript = "Circleback/Transcripts/Planning sync-transcript.md";
    expect(result.note).toBe(note);
    expect(result.transcript).toBe(transcript);
    expect(note.path).toBe(newNote);
    expect(transcript.path).toBe(newTranscript);
    expect(markdownPaths(app)).toEqual([newNote, newTranscript]);
    expect(frontmatter(app, newNote)).toMatchObject({ title: "Planning sync", transcript: `[[${newTranscript}]]` });
    expect(frontmatter(app, newTranscript)).toMatchObject({ title: "Planning sync", note: `[[${newNote}]]` });
  });

  it("does not move files when the folder setting changes", async () => {
    const { app, writer } = await setup();
    await writer.write(ONE, SEGMENTS, context());

    const moved = {
      customBaseFolder: "Meetings/Circleback",
      subfolderPattern: "year-month" as const,
      customTranscriptBaseFolder: "Meetings/Circleback/Transcripts",
    };
    await writer.write(edited(), SEGMENTS, context(moved, { force: true }));
    expect(markdownPaths(app)).toEqual([NOTE, TRANSCRIPT]);

    // Not even together with a title change: the files are no longer where the new settings put them.
    await writer.write(edited({ name: "Planning sync" }), SEGMENTS, context(moved, { force: true }));
    await writer.write(edited({ name: "Planning sync" }), SEGMENTS, context({ baseFolderType: "daily-notes" }, { force: true }));
    expect(markdownPaths(app)).toEqual([NOTE, TRANSCRIPT]);
    expect(app.exists("Meetings")).toBe(false);
    expect(app.exists("Daily")).toBe(false);
  });

  it("adds a collision suffix for a different meeting with the same title and day", async () => {
    const { app, writer } = await setup();
    await writer.write(ONE, SEGMENTS, context());
    const firstNote = app.fileText(NOTE);
    const firstTranscript = app.fileText(TRANSCRIPT);

    // Same title, same day, 14:00 in Chicago; then another one in the same minute.
    const second = meeting({ id: "fixture-meeting-0101", createdAt: "2026-10-26T19:00:00.000Z" });
    const third = meeting({ id: "fixture-meeting-0102", createdAt: "2026-10-26T19:00:00.000Z" });
    const two = await writer.write(second, SEGMENTS, context());
    const three = await writer.write(third, SEGMENTS, context());

    expect(two.note?.path).toBe("Circleback/Meeting 1-2026-10-26_14-00.md");
    expect(two.transcript?.path).toBe("Circleback/Transcripts/Meeting 1-transcript-2026-10-26_14-00.md");
    expect(three.note?.path).toBe("Circleback/Meeting 1-2026-10-26_14-00-2.md");
    expect(frontmatter(app, "Circleback/Meeting 1-2026-10-26_14-00.md")).toMatchObject({
      circleback_id: "fixture-meeting-0101",
      transcript: "[[Circleback/Transcripts/Meeting 1-transcript-2026-10-26_14-00.md]]",
    });
    expect(app.fileText(NOTE)).toBe(firstNote);
    expect(app.fileText(TRANSCRIPT)).toBe(firstTranscript);
  });

  it("skips an unchanged meeting", async () => {
    const { app, index, writer } = await setup();
    await writer.write(ONE, SEGMENTS, context());
    await index.build();
    const spies = watchWrites(app);

    const result = await writer.write(ONE, SEGMENTS, context());

    expect(result).toEqual({
      note: file(app, NOTE),
      transcript: file(app, TRANSCRIPT),
      oldStart: "2026-10-26T15:00:00.000Z",
      changed: false,
    });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("re-fetches when the transcript file is missing", async () => {
    const { app, index, writer } = await setup();
    await writer.write(ONE, SEGMENTS, context());
    await app.vault.delete(file(app, TRANSCRIPT));

    expect(writer.isCurrent(ONE, context(), false)).toBe(true);
    expect(writer.isCurrent(ONE, context(), true)).toBe(false);

    const result = await writer.write(ONE, SEGMENTS, context());

    expect(result.changed).toBe(true);
    expect(result.transcript?.path).toBe(TRANSCRIPT);
    expect(markdownPaths(app)).toEqual([NOTE, TRANSCRIPT]);
    expect(index.find(ONE.id, "transcript")).toEqual([file(app, TRANSCRIPT)]);
    expect(frontmatter(app, NOTE).transcript).toBe(`[[${TRANSCRIPT}]]`);
    expect(writer.isCurrent(ONE, context(), true)).toBe(true);
  });

  it("does not mark the note current if the transcript write throws", async () => {
    const { app, index, writer } = await setup();
    await writer.write(ONE, SEGMENTS, context());
    const noteBefore = app.fileText(NOTE);

    const process = app.vault.process.bind(app.vault);
    jest.spyOn(app.vault, "process").mockImplementation(async (target, fn) => {
      if (target.path === TRANSCRIPT) throw new Error("disk full");
      return process(target, fn);
    });

    const later = edited({ notes: "#### New notes" });
    await expect(writer.write(later, SEGMENTS, context())).rejects.toThrow("disk full");

    expect(app.fileText(NOTE)).toBe(noteBefore);
    expect(frontmatter(app, NOTE).circleback_updated).toBe(ONE.updatedAt);
    await index.build();
    expect(writer.isCurrent(later, context(), true)).toBe(false);

    jest.restoreAllMocks();
    await writer.write(later, SEGMENTS, context());
    expect(frontmatter(app, NOTE).circleback_updated).toBe(LATER);
    expect(writer.isCurrent(later, context(), true)).toBe(true);
  });

  it("creates no note when a new meeting's transcript cannot be created", async () => {
    const { app, index, writer } = await setup();
    const create = app.vault.create.bind(app.vault);
    jest.spyOn(app.vault, "create").mockImplementation(async (path, data) => {
      if (path === TRANSCRIPT) throw new Error("disk full");
      return create(path, data);
    });

    await expect(writer.write(ONE, SEGMENTS, context())).rejects.toThrow("disk full");

    expect(markdownPaths(app)).toEqual([]);
    expect(index.find(ONE.id, "note")).toEqual([]);
  });

  it("writes a combined file in combined mode", async () => {
    const { app, writer } = await setup();
    const result = await writer.write(ONE, SEGMENTS, context({ transcriptHandling: "combined" }));

    expect(markdownPaths(app)).toEqual([NOTE]);
    expect(result.note?.path).toBe(NOTE);
    expect(result.transcript).toBeNull();

    const fm = frontmatter(app, NOTE);
    expect(fm).toMatchObject({ type: "note", circleback_kind: "combined", attendees: ["Person A", "Person B"] });
    expect(fm).not.toHaveProperty("transcript");
    expect(fm).not.toHaveProperty("note");

    // The note body, its closing link, then the transcript under its own heading, as in granola-sync.
    const blocks = buildTranscriptBody("Meeting 1", SEGMENTS, ONE.createdAt, "Owner Person", "You").replace(
      "# Transcript for: Meeting 1\n\n",
      "",
    );
    const body = bodyOf(app, NOTE);
    expect(body).toBe(`${buildNoteBody(ONE, BODY_OPTIONS)}\n## Transcript\n\n${blocks}`);
    expect(body).not.toContain("# Transcript for:");
    expect(body.indexOf("View in Circleback:")).toBeLessThan(body.indexOf("## Transcript"));
  });

  it("writes a combined file with only the note body when there is no transcript", async () => {
    const { app, writer } = await setup();
    await writer.write(ONE, null, context({ transcriptHandling: "combined" }));

    expect(markdownPaths(app)).toEqual([NOTE]);
    expect(bodyOf(app, NOTE)).toBe(buildNoteBody(ONE, BODY_OPTIONS));
  });
});

describe("NoteWriter self label", () => {
  it("uses the owner's name when the self label is name", async () => {
    const { app, writer } = await setup();
    await writer.write(ONE, SEGMENTS, context({ selfLabel: "name" }));
    expect(bodyOf(app, TRANSCRIPT)).toContain("### Owner Person (2026-10-26T15:00:09.800Z)");
    expect(bodyOf(app, TRANSCRIPT)).not.toContain("### You");
  });
});

describe("NoteWriter.isCurrent", () => {
  it("is false when forced, when the note is missing, or when it is older", async () => {
    const { writer } = await setup();
    expect(writer.isCurrent(ONE, context(), false)).toBe(false);

    await writer.write(ONE, SEGMENTS, context());
    expect(writer.isCurrent(ONE, context(), true)).toBe(true);
    expect(writer.isCurrent(ONE, FORCED, true)).toBe(false);
    expect(writer.isCurrent(edited(), context(), true)).toBe(false);
  });

  it("compares instants, not strings", async () => {
    const { app, index, writer } = await setup();
    await writer.write(ONE, null, context());

    // 17:00+02:00 is 15:00Z, older than 16:10Z although it sorts after it as text.
    await addFrontmatter(app, NOTE, { circleback_updated: "2026-10-26T17:00:00+02:00" });
    await index.build();
    expect(writer.isCurrent(ONE, context(), false)).toBe(false);

    // 11:10-05:00 is 16:10Z, the same instant written another way.
    await addFrontmatter(app, NOTE, { circleback_updated: "2026-10-26T11:10:00-05:00" });
    await index.build();
    expect(writer.isCurrent(ONE, context(), false)).toBe(true);
  });

  it("treats an unparseable circleback_updated as not current", async () => {
    const { app, index, writer } = await setup();
    await writer.write(ONE, null, context());
    await addFrontmatter(app, NOTE, { circleback_updated: "yesterday" });
    await index.build();
    expect(writer.isCurrent(ONE, context(), false)).toBe(false);
  });

  it("counts the combined file as the transcript in combined mode", async () => {
    const { writer } = await setup();
    const combined = context({ transcriptHandling: "combined" });
    await writer.write(ONE, SEGMENTS, combined);
    expect(writer.isCurrent(ONE, combined, true)).toBe(true);
    // With separate transcripts, the combined file has yet to be turned into a note.
    expect(writer.isCurrent(ONE, context(), false)).toBe(false);
  });

  it("skips a meeting with no transcript once its note is current", async () => {
    const { app, index, writer } = await setup();
    expect((await writer.write(ONE, null, context())).changed).toBe(true);
    await index.build();
    const spies = watchWrites(app);

    const result = await writer.write(ONE, null, context());

    expect(result.changed).toBe(false);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("NoteWriter.existing", () => {
  it("gives the meeting's files as they are, and writes nothing", async () => {
    const { app, writer } = await setup();
    expect(writer.existing(ONE, context())).toEqual({ note: null, transcript: null, oldStart: null, changed: false });

    await writer.write(ONE, SEGMENTS, context());
    const spies = watchWrites(app);
    const result = writer.existing(edited(), context());

    expect(result.note?.path).toBe(NOTE);
    expect(result.transcript?.path).toBe(TRANSCRIPT);
    expect(result.changed).toBe(false);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("NoteWriter in sections mode", () => {
  const sections = { saveAs: "sections" as const };

  it("writes only the transcript, without a note link", async () => {
    const { app, writer } = await setup();
    const result = await writer.write(ONE, SEGMENTS, context(sections));

    expect(result).toMatchObject({ note: null, oldStart: null, changed: true });
    expect(result.transcript?.path).toBe(TRANSCRIPT);
    expect(markdownPaths(app)).toEqual([TRANSCRIPT]);
    expect(frontmatter(app, TRANSCRIPT)).toMatchObject({ type: "transcript", circleback_kind: "transcript" });
    expect(frontmatter(app, TRANSCRIPT)).not.toHaveProperty("note");
  });

  it("puts a same-location transcript in the daily notes folder", async () => {
    const { app, writer } = await setup();
    await writer.write(ONE, SEGMENTS, context({ ...sections, transcriptHandling: "same-location" }));
    expect(markdownPaths(app)).toEqual(["Daily/Meeting 1-transcript.md"]);
  });

  it("writes nothing without a transcript or in combined mode", async () => {
    const { app, writer } = await setup();
    const spies = watchWrites(app);

    expect(await writer.write(ONE, null, context(sections))).toEqual({
      note: null,
      transcript: null,
      oldStart: null,
      changed: false,
    });
    expect((await writer.write(ONE, SEGMENTS, context({ ...sections, transcriptHandling: "combined" }))).changed).toBe(
      false,
    );
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("is current only for a current transcript", async () => {
    const { writer } = await setup();
    expect(writer.isCurrent(ONE, context(sections), true)).toBe(false);

    await writer.write(ONE, SEGMENTS, context(sections));
    expect(writer.isCurrent(ONE, context(sections), true)).toBe(true);
    expect(writer.isCurrent(ONE, context(sections), false)).toBe(false);
    expect(writer.isCurrent(edited(), context(sections), true)).toBe(false);
    expect(writer.isCurrent(ONE, context({ ...sections, transcriptHandling: "combined" }), true)).toBe(false);
  });
});

describe("NoteWriter note and combined files", () => {
  const combined = context({ transcriptHandling: "combined" });

  it("turns the note into the combined file when transcripts switch to combined", async () => {
    const { app, index, writer } = await setup();
    await writer.write(ONE, SEGMENTS, context());
    await addFrontmatter(app, NOTE, { people: ["[[Person A]]"] });
    await index.build();
    const note = file(app, NOTE);
    const transcriptBefore = app.fileText(TRANSCRIPT);
    expect(writer.isCurrent(ONE, combined, true)).toBe(false);

    const result = await writer.write(ONE, SEGMENTS, combined);

    expect(result).toMatchObject({ note, transcript: null, oldStart: ONE.createdAt, changed: true });
    expect(markdownPaths(app)).toEqual([NOTE, TRANSCRIPT]);
    const fm = frontmatter(app, NOTE);
    expect(fm).toMatchObject({
      circleback_kind: "combined",
      type: "note",
      people: ["[[Person A]]"],
      circleback_first_synced: NOW,
    });
    expect(fm).not.toHaveProperty("transcript");
    expect(bodyOf(app, NOTE)).toContain("\n## Transcript\n\n### Person A (");
    // The transcript file from separate mode is left exactly as it was.
    expect(app.fileText(TRANSCRIPT)).toBe(transcriptBefore);
    expect(index.find(ONE.id, "note")).toEqual([]);
    expect(index.find(ONE.id, "combined")).toEqual([note]);
    expect(writer.isCurrent(ONE, combined, true)).toBe(true);
  });

  it("turns the combined file into a note when transcripts become separate files", async () => {
    const { app, index, writer } = await setup();
    await writer.write(ONE, SEGMENTS, combined);
    const note = file(app, NOTE);
    expect(writer.isCurrent(ONE, context(), true)).toBe(false);

    const result = await writer.write(ONE, SEGMENTS, context());

    expect(result.note).toBe(note);
    expect(result.transcript?.path).toBe(TRANSCRIPT);
    expect(markdownPaths(app)).toEqual([NOTE, TRANSCRIPT]);
    expect(frontmatter(app, NOTE)).toMatchObject({ circleback_kind: "note", transcript: `[[${TRANSCRIPT}]]` });
    expect(bodyOf(app, NOTE)).toBe(buildNoteBody(ONE, BODY_OPTIONS));
    expect(index.find(ONE.id, "combined")).toEqual([]);
    expect(index.find(ONE.id, "note")).toEqual([note]);
  });

  it("takes over an unindexed note of the other kind instead of adding a copy", async () => {
    const { app, writer } = await setup();
    await app.vault.createFolder("Circleback");
    await app.vault.create(
      NOTE,
      fileText(
        { title: "Meeting 1", created: ONE.createdAt, circleback_id: ONE.id, circleback_kind: "combined" },
        "Old body.\n",
      ),
    );

    await writer.write(ONE, null, context());

    expect(markdownPaths(app)).toEqual([NOTE]);
    expect(frontmatter(app, NOTE).circleback_kind).toBe("note");
  });
});

describe("NoteWriter with notes off", () => {
  const notesOff = { syncNotes: false };

  it("writes only the transcript, without a note link", async () => {
    const { app, writer } = await setup();
    const result = await writer.write(ONE, SEGMENTS, context(notesOff));

    expect(result).toMatchObject({ note: null, oldStart: null, changed: true });
    expect(result.transcript?.path).toBe(TRANSCRIPT);
    expect(markdownPaths(app)).toEqual([TRANSCRIPT]);
    expect(frontmatter(app, TRANSCRIPT)).toMatchObject({ type: "transcript", circleback_kind: "transcript" });
    expect(frontmatter(app, TRANSCRIPT)).not.toHaveProperty("note");
  });

  it("puts a same-location or combined transcript in the folder of the note's computed path", async () => {
    for (const transcriptHandling of ["same-location", "combined"] as const) {
      const { app, writer } = await setup();
      const result = await writer.write(ONE, SEGMENTS, context({ ...notesOff, transcriptHandling }));
      expect(result.transcript?.path).toBe("Circleback/Meeting 1-transcript.md");
      expect(markdownPaths(app)).toEqual(["Circleback/Meeting 1-transcript.md"]);
      expect(frontmatter(app, "Circleback/Meeting 1-transcript.md").circleback_kind).toBe("transcript");
    }
  });

  it("writes nothing without a transcript", async () => {
    const { app, writer } = await setup();
    const spies = watchWrites(app);

    const result = await writer.write(ONE, null, context(notesOff));

    expect(result).toEqual({ note: null, transcript: null, oldStart: null, changed: false });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("leaves an existing note alone and drops the transcript's note link", async () => {
    const { app, writer } = await setup();
    await writer.write(ONE, SEGMENTS, context());
    const noteBefore = app.fileText(NOTE);

    await writer.write(edited(), SEGMENTS, context(notesOff));

    expect(app.fileText(NOTE)).toBe(noteBefore);
    expect(frontmatter(app, TRANSCRIPT).circleback_updated).toBe(LATER);
    expect(frontmatter(app, TRANSCRIPT)).not.toHaveProperty("note");
  });

  it("is current only for a current transcript", async () => {
    const { writer } = await setup();
    const off = context(notesOff);
    expect(writer.isCurrent(ONE, off, true)).toBe(false);

    await writer.write(ONE, SEGMENTS, off);
    expect(writer.isCurrent(ONE, off, true)).toBe(true);
    expect(writer.isCurrent(ONE, off, false)).toBe(false);
    expect(writer.isCurrent(edited(), off, true)).toBe(false);
    expect(writer.isCurrent(ONE, context({ ...notesOff, transcriptHandling: "combined" }), true)).toBe(true);
  });
});

describe("NoteWriter frontmatter", () => {
  it("hashes exactly the body that follows the frontmatter, on create and on update", async () => {
    const { app, writer } = await setup();
    await writer.write(ONE, SEGMENTS, context());
    for (const path of [NOTE, TRANSCRIPT]) {
      expect(frontmatter(app, path).circleback_hash).toBe(hashBody(bodyOf(app, path)));
    }

    const later = edited({ notes: "#### Changed\n* Something else." });
    await writer.write(later, SEGMENTS, context());
    expect(bodyOf(app, NOTE)).toBe(buildNoteBody(later, BODY_OPTIONS));
    for (const path of [NOTE, TRANSCRIPT]) {
      expect(frontmatter(app, path).circleback_hash).toBe(hashBody(bodyOf(app, path)));
    }
  });

  it("keeps a body that starts with a horizontal rule out of the frontmatter", async () => {
    const { app, writer } = await setup();
    const ruled = meeting({ notes: "---\nsummary: not a property\n---\nText." });
    await writer.write(ruled, null, context());

    const fm = frontmatter(app, NOTE);
    expect(fm).not.toHaveProperty("summary");
    expect(fm.circleback_id).toBe(ONE.id);
    expect(bodyOf(app, NOTE)).toContain("summary: not a property\n---\nText.");
    expect(fm.circleback_hash).toBe(hashBody(bodyOf(app, NOTE)));

    await writer.write(edited({ notes: ruled.notes }), null, context());
    expect(frontmatter(app, NOTE)).not.toHaveProperty("summary");
    expect(frontmatter(app, NOTE).circleback_hash).toBe(hashBody(bodyOf(app, NOTE)));
  });

  it("keeps the frontmatter fence intact when the user emptied the body", async () => {
    const { app, index, writer } = await setup();
    await writer.write(ONE, null, context());
    const text = app.fileText(NOTE);
    await app.vault.modify(file(app, NOTE), text.slice(0, text.length - bodyOf(app, NOTE).length - 1));
    expect(app.fileText(NOTE).endsWith("\n---")).toBe(true);
    await index.build();

    await writer.write(edited(), null, context());

    expect(frontmatter(app, NOTE).circleback_updated).toBe(LATER);
    expect(bodyOf(app, NOTE)).toBe(buildNoteBody(ONE, BODY_OPTIONS));
  });

  it("removes a plugin field the meeting no longer has, and nothing else", async () => {
    const { app, writer } = await setup();
    await writer.write(ONE, SEGMENTS, context());
    expect(frontmatter(app, NOTE).meeting_url).toBe("https://meet.example.com/abc-defg-hij");
    // Fields the plugin never writes on these files are the user's.
    await addFrontmatter(app, NOTE, { note: "remember the deck" });
    await addFrontmatter(app, TRANSCRIPT, { attendees: ["Person A"], attendee_emails: ["a@example.com"] });

    await writer.write(edited({ url: null }), SEGMENTS, context());

    const note = frontmatter(app, NOTE);
    expect(note).not.toHaveProperty("meeting_url");
    expect(note).toMatchObject({ note: "remember the deck", type: "note", circleback_first_synced: NOW });
    expect(frontmatter(app, TRANSCRIPT)).not.toHaveProperty("meeting_url");
    expect(frontmatter(app, TRANSCRIPT)).toMatchObject({ attendees: ["Person A"], attendee_emails: ["a@example.com"] });
  });

  it("keeps linking an existing transcript when this run has none", async () => {
    const { app, writer } = await setup();
    await writer.write(ONE, SEGMENTS, context());

    const result = await writer.write(edited(), null, context());

    expect(result.transcript).toBe(file(app, TRANSCRIPT));
    expect(frontmatter(app, NOTE)).toMatchObject({ transcript: `[[${TRANSCRIPT}]]`, circleback_updated: LATER });
    expect(markdownPaths(app)).toEqual([NOTE, TRANSCRIPT]);
  });

  it("drops the transcript link when there is no transcript file", async () => {
    const { app, writer } = await setup();
    await writer.write(ONE, SEGMENTS, context());
    await app.vault.delete(file(app, TRANSCRIPT));

    await writer.write(edited(), null, context());

    expect(frontmatter(app, NOTE)).not.toHaveProperty("transcript");
  });

  it("leaves no file behind when a new file cannot be created, so the next run starts clean", async () => {
    const { app, index, writer } = await setup();
    jest.spyOn(app.vault, "create").mockRejectedValueOnce(new Error("disk full"));
    const trashFile = jest.spyOn(app.fileManager, "trashFile");

    await expect(writer.write(ONE, SEGMENTS, context())).rejects.toThrow("disk full");

    expect(markdownPaths(app)).toEqual([]);
    expect(trashFile).not.toHaveBeenCalled();
    expect(index.find(ONE.id, "transcript")).toEqual([]);

    await writer.write(ONE, SEGMENTS, context());
    expect(markdownPaths(app)).toEqual([NOTE, TRANSCRIPT]);
  });

  it("orders the writes transcript first and the note's frontmatter last", async () => {
    const { app, writer } = await setup();
    const calls: string[] = [];
    const create = app.vault.create.bind(app.vault);
    const process = app.vault.process.bind(app.vault);
    const processFrontMatter = app.fileManager.processFrontMatter.bind(app.fileManager);
    jest.spyOn(app.vault, "create").mockImplementation(async (path, data) => {
      calls.push(`create ${path}`);
      return create(path, data);
    });
    jest.spyOn(app.vault, "process").mockImplementation(async (target, fn) => {
      calls.push(`body ${target.path}`);
      return process(target, fn);
    });
    jest.spyOn(app.fileManager, "processFrontMatter").mockImplementation(async (target, fn) => {
      calls.push(`frontmatter ${target.path}`);
      return processFrontMatter(target, fn);
    });

    await writer.write(ONE, SEGMENTS, context());
    await writer.write(edited(), SEGMENTS, context());

    expect(calls).toEqual([
      `create ${TRANSCRIPT}`,
      `create ${NOTE}`,
      `body ${TRANSCRIPT}`,
      `frontmatter ${TRANSCRIPT}`,
      `body ${NOTE}`,
      `frontmatter ${NOTE}`,
    ]);
  });
});

describe("NoteWriter creating a file", () => {
  const FIELD_CONTEXT = { accountLabel: "Work", ownerEmail: "owner@example.com" };

  /** A meeting whose note body hashes to something YAML would read as a number if it were not quoted. */
  function meetingWithHash(pattern: RegExp): Meeting {
    for (let n = 0; n < 5000; n++) {
      const candidate = meeting({ notes: `Note ${n}` });
      if (pattern.test(hashBody(buildNoteBody(candidate, BODY_OPTIONS)))) return candidate;
    }
    throw new Error(`No note body hashes to ${String(pattern)}`);
  }

  /** A file made the way the plugin once made it: the body alone first, the frontmatter added after. */
  async function createTwoStep(
    app: FakeApp,
    path: string,
    kind: "note" | "transcript",
    body: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    await app.vault.create(path, body);
    await app.fileManager.processFrontMatter(file(app, path), (fm: Record<string, unknown>) => {
      fm.type = kind;
      Object.assign(fm, fields);
      fm.circleback_first_synced = NOW;
    });
  }

  it("creates each new file with one create call and no write after it", async () => {
    const { app, index, writer } = await setup();
    const [create, createFolder, modify, process, processFrontMatter, renameFile, trashFile] = watchWrites(app);

    const result = await writer.write(ONE, SEGMENTS, context());

    expect(create.mock.calls.map(([path]) => path)).toEqual([TRANSCRIPT, NOTE]);
    expect(createFolder).toHaveBeenCalled();
    for (const spy of [modify, process, processFrontMatter, renameFile, trashFile]) expect(spy).not.toHaveBeenCalled();
    // The text handed to create is the finished file: frontmatter first, then the body.
    for (const [path, text] of create.mock.calls as Array<[string, string]>) {
      expect(text.startsWith("---\n")).toBe(true);
      expect(splitFrontmatter(text).yaml).toContain(`circleback_id: ${ONE.id}`);
      expect(text).toBe(app.fileText(path));
    }
    // The index knows both files without waiting for the metadata cache.
    expect(index.find(ONE.id, "note")).toEqual([result.note]);
    expect(index.find(ONE.id, "transcript")).toEqual([result.transcript]);
    expect(index.frontmatter(file(app, NOTE))).toEqual(frontmatter(app, NOTE));
    expect(index.frontmatter(file(app, TRANSCRIPT))).toEqual(frontmatter(app, TRANSCRIPT));
  });

  it("creates a combined file, and a transcript with no note, in one write each", async () => {
    const { app, writer } = await setup();
    const [create, , modify, process, processFrontMatter] = watchWrites(app);

    await writer.write(ONE, SEGMENTS, context({ transcriptHandling: "combined" }));
    await writer.write(edited({ id: "other" }), SEGMENTS, context({ saveAs: "sections" }));

    expect(create).toHaveBeenCalledTimes(2);
    for (const spy of [modify, process, processFrontMatter]) expect(spy).not.toHaveBeenCalled();
    expect(frontmatter(app, NOTE)).toMatchObject({ circleback_kind: "combined", circleback_id: ONE.id });
  });

  it("splits the body back out exactly, so its hash is the stored hash", async () => {
    const ruled = meeting({ notes: "---\nsummary: not a property\n---\nText." });
    const cases: Array<[string, Meeting, Partial<CirclebackSyncSettings>, string[]]> = [
      ["a note and its transcript", ONE, {}, [NOTE, TRANSCRIPT]],
      ["a combined file", ONE, { transcriptHandling: "combined" }, [NOTE]],
      ["a note whose body opens with a rule", ruled, {}, [NOTE, TRANSCRIPT]],
    ];
    for (const [, m, settings, paths] of cases) {
      const { app, writer } = await setup();
      await writer.write(m, SEGMENTS, context(settings));
      for (const path of paths) {
        const { body } = splitFrontmatter(app.fileText(path));
        expect(frontmatter(app, path).circleback_hash).toBe(hashBody(body));
      }
    }

    const { app, writer } = await setup();
    await writer.write(ONE, SEGMENTS, context());
    expect(splitFrontmatter(app.fileText(NOTE)).body).toBe(buildNoteBody(ONE, BODY_OPTIONS));
    expect(splitFrontmatter(app.fileText(TRANSCRIPT)).body).toBe(
      buildTranscriptBody("Meeting 1", SEGMENTS, ONE.createdAt, "Owner Person", "You"),
    );
  });

  it("gives a new file the same frontmatter, key for key and in the same order, as the two-step way did", async () => {
    const { app, writer } = await setup();
    await writer.write(ONE, SEGMENTS, context());

    const reference = createFakeApp();
    await reference.vault.createFolder("Circleback");
    await reference.vault.createFolder("Circleback/Transcripts");
    const noteBody = bodyOf(app, NOTE);
    const transcriptBody = bodyOf(app, TRANSCRIPT);
    await createTwoStep(
      reference,
      NOTE,
      "note",
      noteBody,
      buildFields(ONE, { ...FIELD_CONTEXT, kind: "note", linkTo: TRANSCRIPT, hash: hashBody(noteBody) }),
    );
    await createTwoStep(
      reference,
      TRANSCRIPT,
      "transcript",
      transcriptBody,
      buildFields(ONE, { ...FIELD_CONTEXT, kind: "transcript", linkTo: NOTE, hash: hashBody(transcriptBody) }),
    );

    for (const path of [NOTE, TRANSCRIPT]) {
      const created = frontmatter(app, path);
      const expected = frontmatter(reference, path);
      expect(Object.keys(created)).toEqual(Object.keys(expected));
      expect(created).toEqual(expected);
      expect(bodyOf(app, path)).toBe(bodyOf(reference, path));
    }
    // The creation keys sit where they always did: `type` first, `circleback_first_synced` last.
    const keys = Object.keys(frontmatter(app, NOTE));
    expect(keys[0]).toBe("type");
    expect(keys[keys.length - 1]).toBe("circleback_first_synced");
  });

  it.each([
    ["only digits", /^\d{8}$/],
    // Like "417226e6": a number once the e is read as an exponent (a short one, so it stays finite).
    ["digits around one e", /^\d{5,6}e\d{1,2}$/],
  ])("keeps a hash of %s a string, as the stored hash and in the index", async (_name, pattern) => {
    const m = meetingWithHash(pattern);
    const { app, index, writer } = await setup();

    const result = await writer.write(m, null, context());

    const hash = hashBody(bodyOf(app, NOTE));
    expect(hash).toMatch(pattern);
    expect(frontmatter(app, NOTE).circleback_hash).toBe(hash);
    expect(index.frontmatter(file(app, NOTE))?.circleback_hash).toBe(hash);
    expect(result.note).toBe(file(app, NOTE));
  });
});

describe("NoteWriter paths", () => {
  it("does not rename when the previous created is not a valid date", async () => {
    const { app, index, writer } = await setup();
    await writer.write(ONE, null, context());
    await addFrontmatter(app, NOTE, { created: "sometime last week" });
    await index.build();

    await writer.write(edited({ name: "Planning sync" }), null, context());

    expect(markdownPaths(app)).toEqual([NOTE]);
    expect(frontmatter(app, NOTE).created).toBe(ONE.createdAt);
  });

  it("treats a path that differs only in case as taken", async () => {
    const userFile = "Circleback/meeting 1.md";
    const { app, writer } = await setup({ [userFile]: "My own notes.\n" });

    const result = await writer.write(ONE, null, context());

    expect(result.note?.path).toBe("Circleback/Meeting 1-2026-10-26_10-00.md");
    expect(app.fileText(userFile)).toBe("My own notes.\n");
  });

  it("updates an unindexed file of the same meeting at its path instead of adding a copy", async () => {
    const { app, index, writer } = await setup();
    // Another device synced this meeting's note in after the index was built.
    await app.vault.createFolder("Circleback");
    const synced = await app.vault.create(
      NOTE,
      fileText(
        {
          title: "Meeting 1",
          created: ONE.createdAt,
          type: "note",
          circleback_id: ONE.id,
          circleback_kind: "note",
          circleback_updated: ONE.updatedAt,
          circleback_first_synced: "2026-10-26T20:00:00.000Z",
          people: ["[[Person A]]"],
        },
        "Old body.\n",
      ),
    );
    expect(index.find(ONE.id, "note")).toEqual([]);

    const result = await writer.write(edited(), null, context());

    expect(result.note).toBe(synced);
    expect(result.oldStart).toBe(ONE.createdAt);
    expect(markdownPaths(app)).toEqual([NOTE]);
    expect(frontmatter(app, NOTE)).toMatchObject({
      people: ["[[Person A]]"],
      circleback_first_synced: "2026-10-26T20:00:00.000Z",
      circleback_updated: LATER,
    });
    expect(index.find(ONE.id, "note")).toEqual([synced]);
  });

  it("keeps the note's path free when the transcript pattern gives the same name", async () => {
    const { app, writer } = await setup();
    const result = await writer.write(
      ONE,
      SEGMENTS,
      context({ transcriptHandling: "same-location", transcriptFilenamePattern: "{title}" }),
    );

    expect(result.note?.path).toBe(NOTE);
    expect(result.transcript?.path).toBe("Circleback/Meeting 1-2026-10-26_10-00.md");
    expect(frontmatter(app, NOTE).circleback_kind).toBe("note");
    expect(frontmatter(app, "Circleback/Meeting 1-2026-10-26_10-00.md").note).toBe(`[[${NOTE}]]`);
  });

  it("puts a new same-location transcript beside a note the user moved", async () => {
    const { app, writer } = await setup();
    await writer.write(ONE, null, context({ transcriptHandling: "same-location" }));
    await move(app, NOTE, "Work/x.md");

    await writer.write(edited(), SEGMENTS, context({ transcriptHandling: "same-location" }));

    expect(markdownPaths(app)).toEqual(["Work/Meeting 1-transcript.md", "Work/x.md"]);
  });

  it("creates missing parent folders", async () => {
    const { app, writer } = await setup();
    const nested = {
      customBaseFolder: "Meetings/Circleback",
      subfolderPattern: "year-month" as const,
      customTranscriptBaseFolder: "Meetings/Circleback/Transcripts",
      transcriptSubfolderPattern: "day" as const,
    };
    await writer.write(ONE, SEGMENTS, context(nested));
    expect(markdownPaths(app)).toEqual([
      "Meetings/Circleback/2026/10/Meeting 1.md",
      "Meetings/Circleback/Transcripts/2026-10-26/Meeting 1-transcript.md",
    ]);
  });

  it("renames in place on a date change under a date-based subfolder, and reports the old start", async () => {
    const { app, writer } = await setup();
    const daily = context({ subfolderPattern: "day", filenamePattern: "{date} - {title}" });
    await writer.write(ONE, null, daily);
    expect(markdownPaths(app)).toEqual(["Circleback/2026-10-26/2026-10-26 - Meeting 1.md"]);

    const result = await writer.write(edited({ createdAt: "2026-10-27T15:00:00.000Z" }), null, daily);

    // The file name follows the new date; the folder stays: the plugin never moves a file into another folder.
    expect(result.oldStart).toBe(ONE.createdAt);
    expect(markdownPaths(app)).toEqual(["Circleback/2026-10-26/2026-10-27 - Meeting 1.md"]);
    expect(app.exists("Circleback/2026-10-27")).toBe(false);
    expect(frontmatter(app, "Circleback/2026-10-26/2026-10-27 - Meeting 1.md").created).toBe("2026-10-27T15:00:00.000Z");
  });

  it("keeps a file where it is when a date change alters only the folder part of its path", async () => {
    const { app, writer } = await setup();
    const daily = context({ subfolderPattern: "day" });
    await writer.write(ONE, null, daily);

    await writer.write(edited({ createdAt: "2026-10-27T15:00:00.000Z" }), null, daily);

    expect(markdownPaths(app)).toEqual(["Circleback/2026-10-26/Meeting 1.md"]);
    expect(app.exists("Circleback/2026-10-27")).toBe(false);
  });

  it("renames to a collision candidate when the new name is taken", async () => {
    const { app, writer } = await setup();
    const other = meeting({ id: "fixture-meeting-0101", name: "Planning sync", createdAt: "2026-10-26T19:00:00.000Z" });
    await writer.write(other, null, context());
    await writer.write(ONE, null, context());

    await writer.write(edited({ name: "Planning sync" }), null, context());

    expect(markdownPaths(app)).toEqual(["Circleback/Planning sync-2026-10-26_10-00.md", "Circleback/Planning sync.md"]);
    expect(frontmatter(app, "Circleback/Planning sync.md").circleback_id).toBe("fixture-meeting-0101");
    expect(frontmatter(app, "Circleback/Planning sync-2026-10-26_10-00.md").circleback_id).toBe(ONE.id);
  });

  it("sees its own writes within a run", async () => {
    const { app, index, writer } = await setup();
    await writer.write(ONE, SEGMENTS, context());
    await writer.write(ONE, SEGMENTS, FORCED);

    expect(markdownPaths(app)).toEqual([NOTE, TRANSCRIPT]);
    expect(index.find(ONE.id, "note")).toEqual([file(app, NOTE)]);
    expect(index.find(ONE.id, "transcript")).toEqual([file(app, TRANSCRIPT)]);
    expect(writer.isCurrent(ONE, context(), true)).toBe(true);
  });
});
