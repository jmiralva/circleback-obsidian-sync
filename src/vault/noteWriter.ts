// Writes a meeting's note and transcript into the vault, and keeps them up to date.
//
// This is the code that touches the user's notes, so it keeps three promises:
// - One note and one transcript per meeting. Files are found by (circleback_id, circleback_kind)
//   through the index, wherever they were moved or renamed. A `note` and a `combined` file are
//   one identity, the meeting's note: switching transcript handling turns the existing file into
//   the other kind in place. A file of this meeting that the index has not seen yet (synced in
//   from another device mid-run) is taken over, never copied.
// - The user's frontmatter survives. It changes only through processFrontMatter, key by key,
//   and the only keys ever removed are ones the plugin writes on that kind of file.
// - A file the user filed stays put, and no file ever changes folder. A file is renamed (in its
//   folder) only while it sits exactly where the plugin would have put it under its previous
//   title and date, so neither a move by the user nor a change of settings ever moves it.
//
// The transcript is written before the note, and the note's frontmatter (which carries
// `circleback_updated`) is the very last write. A failure anywhere leaves the note looking out
// of date, so the next run tries the meeting again.
import { TFile, normalizePath } from "obsidian";
import type { App, TAbstractFile } from "obsidian";
import { MEETING_START_FIELD } from "../api/constants";
import type { Meeting, TranscriptSegment } from "../api/schemas";
import { REWRITTEN_KEYS, buildFields, isFileKind, meetingTitle, type FileKind } from "../format/fields";
import { buildNoteBody } from "../format/noteBody";
import { collisionCandidate, notePath, transcriptPath, type PathMeeting } from "../format/paths";
import { buildTranscriptBody } from "../format/transcript";
import type { CirclebackSyncSettings } from "../settings/types";
import { hashBody } from "../util/hash";
import { logger } from "../util/logger";
import { meetingLocal, type Moment } from "../util/time";
import { readFrontmatter, splitFrontmatter } from "./frontmatter";
import type { MeetingIndex } from "./meetingIndex";

export type WriteContext = {
  settings: CirclebackSyncSettings;
  accountLabel: string;
  /** The account's email, kept out of the attendees. */
  ownerEmail: string;
  /** The key owner's name in transcripts, or null when not known. */
  ownerName: string | null;
  /** The daily notes folder, for notes and transcripts placed there. */
  dailyFolder: string;
  /** Rewrite even when the vault looks current (full sync). */
  force: boolean;
  now: () => Date;
};

export type WriteResult = {
  /** The note (the combined file in combined mode). Null when there is no note file: sections mode, or notes off. */
  note: TFile | null;
  /** The separate transcript file, written now or kept from an earlier run. Null in combined mode. */
  transcript: TFile | null;
  /** The note's `created` before this write, to move its daily-note line. Null for a new note. */
  oldStart: string | null;
  /** Whether anything in the vault was written. */
  changed: boolean;
};

type NoteKind = Extract<FileKind, "note" | "combined">;

/** Where one file of a meeting is to be after a write. */
interface Placement {
  /** The meeting's existing file, or null when one is to be created. */
  file: TFile | null;
  /** That file's frontmatter as the index holds it (the plugin's last write); empty for a new file. */
  frontmatter: Record<string, unknown>;
  /** Where the file is to be: where it already is, a new name in its folder, or where to create it. */
  path: string;
}

// The fence `splitFrontmatter` takes for the start of a frontmatter block.
const OPENING_FENCE = /^---[ \t]*\r?\n/;
const TRANSCRIPT: readonly FileKind[] = ["transcript"];

export class NoteWriter {
  constructor(
    private readonly app: App,
    private readonly index: MeetingIndex,
  ) {}

  /**
   * Whether the vault already holds this version of the meeting, so there is nothing to write
   * (and no transcript to fetch). This is the rule `write` skips by. Never true when forced.
   *
   * With a note file, the note has to be of the kind the settings call for (a note of the other
   * kind is due to be turned into this one) with a `circleback_updated` no older than the
   * meeting's `updatedAt`, and when `expectTranscript` is true the transcript file has to exist
   * too (in combined mode the combined file is the transcript). Without a note file (sections
   * mode, or notes off), the answer is true only when a transcript is expected and its file is
   * current; the engine rewrites the daily-note block otherwise.
   */
  isCurrent(m: Meeting, ctx: WriteContext, expectTranscript: boolean): boolean {
    if (ctx.force) return false;
    const kind = noteKindFor(ctx.settings);
    if (kind === null) {
      return expectTranscript && hasLoneTranscript(ctx.settings) && this.fileIsCurrent(this.liveFile(m.id, TRANSCRIPT), m);
    }
    const note = this.liveFile(m.id, noteKinds(kind));
    if (note === null || this.index.frontmatter(note)?.circleback_kind !== kind || !this.fileIsCurrent(note, m)) {
      return false;
    }
    return !expectTranscript || kind === "combined" || this.liveFile(m.id, TRANSCRIPT) !== null;
  }

  /**
   * Writes a meeting: its transcript file first (when `transcript` is not null and transcripts
   * are separate files), then its note. A null transcript (turned off, or not allowed) means
   * none is expected, and an existing transcript file is kept and still linked.
   *
   * Nothing is written when `isCurrent` says the vault is up to date. Without a note file
   * (sections mode, or notes off) only the transcript file is written, with no `note` link; the
   * daily-note block is the engine's job.
   */
  async write(m: Meeting, transcript: TranscriptSegment[] | null, ctx: WriteContext): Promise<WriteResult> {
    if (this.isCurrent(m, ctx, transcript !== null)) return this.unchanged(m, ctx);
    const kind = noteKindFor(ctx.settings);
    if (kind !== null) return this.writeFiles(m, kind, transcript, ctx);
    if (transcript === null || !hasLoneTranscript(ctx.settings)) return this.unchanged(m, ctx);
    const file = await this.writeLoneTranscript(m, transcript, ctx);
    return { note: null, transcript: file, oldStart: null, changed: true };
  }

  private async writeFiles(
    m: Meeting,
    kind: NoteKind,
    transcript: TranscriptSegment[] | null,
    ctx: WriteContext,
  ): Promise<WriteResult> {
    const { settings } = ctx;
    const combined = kind === "combined";

    // The note's place is settled first, so that the transcript can link to it.
    const note = await this.place(
      m,
      noteKinds(kind),
      notePath(settings, m, ctx.dailyFolder),
      (previous) => notePath(settings, previous, ctx.dailyFolder),
      [],
    );
    const noteBefore = note.file?.path ?? note.path;

    let transcriptFile: TFile | null = null;
    if (!combined) {
      transcriptFile =
        transcript === null
          ? this.liveFile(m.id, TRANSCRIPT)
          : await this.writeTranscript(m, transcript, ctx, settings, note.path, () => noteBefore, note.path);
    }

    let body = buildNoteBody(m, {
      includePrivateNotes: settings.includePrivateNotes,
      includeActionItems: settings.includeActionItems,
      includeInsights: settings.includeInsights,
    });
    if (combined && transcript !== null) body = withTranscript(body, this.transcriptText(m, transcript, ctx));
    body = storable(body);

    // A combined file never links to a transcript: it holds it.
    const linkTo = combined ? undefined : transcriptFile?.path;
    const file = await this.writeFile(note, kind, body, this.fields(m, ctx, kind, body, linkTo), ctx);
    return { note: file, transcript: transcriptFile, oldStart: validStart(note.frontmatter), changed: true };
  }

  /**
   * The transcript of a meeting with no note file. A same-location transcript goes in the folder
   * the note would be in: the daily notes folder in sections mode, else the folder of the note's
   * computed path. With notes off and transcripts set to combined there is no note to hold the
   * transcript, so it goes there too.
   */
  private async writeLoneTranscript(m: Meeting, segs: TranscriptSegment[], ctx: WriteContext): Promise<TFile> {
    const { settings, dailyFolder } = ctx;
    const pathSettings: CirclebackSyncSettings =
      settings.transcriptHandling === "combined" ? { ...settings, transcriptHandling: "same-location" } : settings;
    // transcriptPath only reads the folder of the note path it is given.
    const besideNote = (meeting: PathMeeting): string =>
      settings.saveAs === "sections" ? normalizePath(`${dailyFolder}/note.md`) : notePath(settings, meeting, dailyFolder);
    return this.writeTranscript(m, segs, ctx, pathSettings, besideNote(m), besideNote);
  }

  /**
   * @param noteNow The note path (after this write) that a same-location transcript goes beside.
   * @param noteBefore The note path that a same-location transcript's previous path is computed beside.
   * @param linkTo The note to link to, if any. Its path also counts as taken, since the note may not be there yet.
   */
  private async writeTranscript(
    m: Meeting,
    segs: TranscriptSegment[],
    ctx: WriteContext,
    pathSettings: CirclebackSyncSettings,
    noteNow: string,
    noteBefore: (previous: PathMeeting) => string,
    linkTo?: string,
  ): Promise<TFile> {
    const placement = await this.place(
      m,
      TRANSCRIPT,
      transcriptPath(pathSettings, m, noteNow),
      (previous) => transcriptPath(pathSettings, previous, noteBefore(previous)),
      linkTo === undefined ? [] : [linkTo],
    );
    const body = this.transcriptText(m, segs, ctx);
    return this.writeFile(placement, "transcript", body, this.fields(m, ctx, "transcript", body, linkTo), ctx);
  }

  /** What `write` returns when it writes nothing: the files the meeting already has. */
  private unchanged(m: Meeting, ctx: WriteContext): WriteResult {
    const kind = noteKindFor(ctx.settings);
    const note = kind === null ? null : this.liveFile(m.id, noteKinds(kind));
    const separate = kind === null ? hasLoneTranscript(ctx.settings) : kind === "note";
    return {
      note,
      transcript: separate ? this.liveFile(m.id, TRANSCRIPT) : null,
      oldStart: note === null ? null : validStart(this.index.frontmatter(note) ?? {}),
      changed: false,
    };
  }

  private transcriptText(m: Meeting, segs: TranscriptSegment[], ctx: WriteContext): string {
    const name = ctx.ownerName === null ? "" : ctx.ownerName.trim();
    const selfLabel = ctx.settings.selfLabel === "name" && name !== "" ? name : "You";
    return buildTranscriptBody(meetingTitle(m), segs, m[MEETING_START_FIELD], ctx.ownerName, selfLabel);
  }

  private fields(
    m: Meeting,
    ctx: WriteContext,
    kind: FileKind,
    body: string,
    linkTo: string | undefined,
  ): Record<string, unknown> {
    return buildFields(m, { accountLabel: ctx.accountLabel, ownerEmail: ctx.ownerEmail, kind, linkTo, hash: hashBody(body) });
  }

  /**
   * Decides where a meeting's file is to be.
   *
   * An existing file (the first match of `kinds`, in that order) stays where it is, unless it is
   * still exactly at `previousPathOf` the title and date it was last written with. Then it takes
   * the newly computed file name in the folder it is in (or the first free collision candidate),
   * never another folder. A new file goes to `computed`, or the first free collision candidate.
   *
   * @param computed Where the plugin puts this file now.
   * @param previousPathOf Where the plugin would have put it under an earlier title and date.
   * @param reserved Paths that count as taken although nothing is there yet.
   */
  private async place(
    m: Meeting,
    kinds: readonly FileKind[],
    computed: string,
    previousPathOf: (previous: PathMeeting) => string,
    reserved: readonly string[],
  ): Promise<Placement> {
    const start = meetingLocal(m[MEETING_START_FIELD]);
    let file = this.liveFile(m.id, kinds);
    if (file === null) {
      const spot = await this.newSpot(m.id, kinds, computed, start, reserved);
      if (typeof spot === "string") return { file: null, frontmatter: {}, path: spot };
      file = spot;
    }

    const frontmatter = this.index.frontmatter(file) ?? {};
    const previous = previousMeeting(frontmatter);
    if (previous === null || file.path !== previousPathOf(previous)) return { file, frontmatter, path: file.path };
    const renamed = withFileName(file.path, computed);
    return { file, frontmatter, path: renamed === file.path ? renamed : this.freePath(renamed, file, start, reserved) };
  }

  /**
   * The first free path among `computed` and its collision candidates. If one of them holds a
   * file of this meeting (of one of `kinds`) that the index did not know, that file is returned
   * instead, to be updated where it is.
   */
  private async newSpot(
    id: string,
    kinds: readonly FileKind[],
    computed: string,
    start: Moment,
    reserved: readonly string[],
  ): Promise<string | TFile> {
    for (let n = 0; ; n++) {
      const candidate = n === 0 ? computed : collisionCandidate(computed, start, n);
      if (isReserved(candidate, reserved)) continue;
      const occupant = this.occupant(candidate, null);
      if (occupant === null) return candidate;
      if (occupant instanceof TFile && (await this.claim(occupant, id, kinds))) return occupant;
    }
  }

  /** The first free path among `target` and its collision candidates, for renaming `self` there. */
  private freePath(target: string, self: TFile, start: Moment, reserved: readonly string[]): string {
    for (let n = 0; ; n++) {
      const candidate = n === 0 ? target : collisionCandidate(target, start, n);
      if (!isReserved(candidate, reserved) && this.occupant(candidate, self) === null) return candidate;
    }
  }

  /**
   * What is at `path`, other than `self`. Paths match without regard to case: on macOS and
   * Windows "Standup.md" and "standup.md" are the same file.
   */
  private occupant(path: string, self: TFile | null): TAbstractFile | null {
    const exact = this.app.vault.getAbstractFileByPath(path);
    if (exact !== null && exact !== self) return exact;
    const wanted = path.toLowerCase();
    return this.app.vault.getFiles().find((other) => other !== self && other.path.toLowerCase() === wanted) ?? null;
  }

  /** Whether a file the index did not know is this meeting's file of one of `kinds`. If so, the index learns it. */
  private async claim(file: TFile, id: string, kinds: readonly FileKind[]): Promise<boolean> {
    let frontmatter: Record<string, unknown> | null;
    try {
      frontmatter = await readFrontmatter(this.app, file);
    } catch (error) {
      logger.warn(`Could not read ${file.path}; treating its path as taken.`, error);
      return false;
    }
    const kind = frontmatter?.circleback_kind;
    if (frontmatter?.circleback_id !== id || !isFileKind(kind) || !kinds.includes(kind)) return false;
    this.index.upsert(file, frontmatter);
    return true;
  }

  /**
   * The meeting's file: the first file still in the vault that the index lists (oldest first)
   * for the first of `kinds`, else for the next. A file deleted or trashed since the index saw
   * it is dropped from the index.
   */
  private liveFile(id: string, kinds: readonly FileKind[]): TFile | null {
    for (const kind of kinds) {
      for (const file of this.index.find(id, kind)) {
        if (this.app.vault.getAbstractFileByPath(file.path) === file) return file;
        this.index.forget(file);
      }
    }
    return null;
  }

  private fileIsCurrent(file: TFile | null, m: Meeting): boolean {
    if (file === null) return false;
    const written = this.index.frontmatter(file)?.circleback_updated;
    // Compared as instants: the same moment can be written with different offsets.
    return typeof written === "string" && Date.parse(written) >= Date.parse(m.updatedAt);
  }

  /** Creates, or renames and updates, the file a placement describes, as a file of `kind`. */
  private async writeFile(
    placement: Placement,
    kind: FileKind,
    body: string,
    fields: Record<string, unknown>,
    ctx: WriteContext,
  ): Promise<TFile> {
    const { file, path, frontmatter } = placement;
    if (file === null) return this.createFile(path, kind, body, fields, ctx.now());

    if (file.path !== path) {
      await this.app.fileManager.renameFile(file, path);
      this.index.upsert(file, frontmatter);
    }
    await this.replaceBody(file, body);
    // A note turning into a combined file (or back) can also lose what it had as its old kind.
    const before = frontmatter.circleback_kind;
    const removable = new Set([...removableKeys(kind), ...(isFileKind(before) ? removableKeys(before) : [])]);
    await this.changeFrontmatter(file, (fm) => {
      for (const key of removable) if (!(key in fields)) delete fm[key];
      Object.assign(fm, fields);
    });
    return file;
  }

  private async createFile(
    path: string,
    kind: FileKind,
    body: string,
    fields: Record<string, unknown>,
    now: Date,
  ): Promise<TFile> {
    await this.ensureFolders(path);
    const file = await this.app.vault.create(path, body);
    try {
      await this.changeFrontmatter(file, (fm) => {
        fm.type = kind === "transcript" ? "transcript" : "note";
        Object.assign(fm, fields);
        fm.circleback_first_synced = now.toISOString();
      });
    } catch (error) {
      // The file holds only the body just written. Left there without a circleback_id, it
      // would hold the meeting's path and the next run would put a second copy beside it.
      await this.discard(file);
      throw error;
    }
    return file;
  }

  /** Replaces everything after the frontmatter block and leaves the block exactly as it is. */
  private async replaceBody(file: TFile, body: string): Promise<void> {
    await this.app.vault.process(file, (text) => {
      const head = text.slice(0, text.length - splitFrontmatter(text).body.length);
      // A closing fence at the very end of the file has no line break after it yet.
      return (head === "" || head.endsWith("\n") ? head : `${head}\n`) + body;
    });
  }

  /** Changes frontmatter through processFrontMatter, then tells the index what the file now holds. */
  private async changeFrontmatter(file: TFile, change: (fm: Record<string, unknown>) => void): Promise<void> {
    let written: Record<string, unknown> | null = null;
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      change(fm);
      written = { ...fm };
    });
    this.index.upsert(file, written);
  }

  private async discard(file: TFile): Promise<void> {
    try {
      await this.app.fileManager.trashFile(file);
    } catch (error) {
      logger.error(`Could not move the incomplete file ${file.path} to the trash. It can be deleted by hand.`, error);
    }
  }

  /** Creates the folders above `path` that do not exist yet: create needs them. */
  private async ensureFolders(path: string): Promise<void> {
    const segments = path.split("/").slice(0, -1);
    for (let depth = 1; depth <= segments.length; depth++) {
      const folder = segments.slice(0, depth).join("/");
      if (this.app.vault.getAbstractFileByPath(folder) === null) await this.app.vault.createFolder(folder);
    }
  }
}

/** The kind of note file the settings call for, or null when there is none: sections mode, or notes off. */
function noteKindFor(settings: CirclebackSyncSettings): NoteKind | null {
  if (settings.saveAs === "sections" || !settings.syncNotes) return null;
  return settings.transcriptHandling === "combined" ? "combined" : "note";
}

/** Note kinds to look a meeting's note up by: `note` and `combined` are one identity, this kind first. */
function noteKinds(kind: NoteKind): readonly FileKind[] {
  return kind === "note" ? ["note", "combined"] : ["combined", "note"];
}

/**
 * Without a note file, whether a transcript gets a file of its own. In sections mode a combined
 * transcript belongs in the daily-note block; with notes off there is nothing else to hold it.
 */
function hasLoneTranscript(settings: CirclebackSyncSettings): boolean {
  return !settings.syncNotes || settings.transcriptHandling !== "combined";
}

/**
 * The plugin keys a file of this kind can lose: the ones `buildFields` writes on it. A key the
 * plugin never writes on this kind of file can only be the user's. `type` and
 * `circleback_first_synced` are not in `REWRITTEN_KEYS`, so they are never removed.
 */
function removableKeys(kind: FileKind): string[] {
  return REWRITTEN_KEYS.filter((key) => {
    switch (key) {
      case "attendees":
      case "attendee_emails":
        return kind !== "transcript";
      case "transcript":
        // A combined file is never given a transcript link.
        return kind === "note";
      case "note":
        return kind === "transcript";
      default:
        return true;
    }
  });
}

/** The title and start a file was last written with, if they can still give a path. */
function previousMeeting(frontmatter: Record<string, unknown>): PathMeeting | null {
  const { title } = frontmatter;
  const start = validStart(frontmatter);
  if (typeof title !== "string" || start === null) return null;
  return { name: title, [MEETING_START_FIELD]: start };
}

function validStart(frontmatter: Record<string, unknown>): string | null {
  const { created } = frontmatter;
  return typeof created === "string" && meetingLocal(created).isValid() ? created : null;
}

/** `path` with its file name replaced by the file name of `computed`: the folder never changes. */
function withFileName(path: string, computed: string): string {
  const name = computed.slice(computed.lastIndexOf("/") + 1);
  const slash = path.lastIndexOf("/");
  return slash < 0 ? name : `${path.slice(0, slash)}/${name}`;
}

function isReserved(path: string, reserved: readonly string[]): boolean {
  const wanted = path.toLowerCase();
  return reserved.some((taken) => taken.toLowerCase() === wanted);
}

/**
 * The note body followed by the transcript under `## Transcript`, after the closing
 * "View in Circleback" line as granola-sync does. The transcript's own `# Transcript for:`
 * heading (and the blank line after it) gives way to the section heading.
 */
function withTranscript(noteBody: string, transcriptBody: string): string {
  const blocks = transcriptBody.slice(transcriptBody.indexOf("\n\n") + 2);
  return `${noteBody}\n## Transcript\n\n${blocks}`;
}

/**
 * A body as it can be stored. A new file is created with its body alone and then given its
 * frontmatter, so a body that opens with `---` (a horizontal rule in Circleback's notes) would
 * be read as a frontmatter block. A leading blank line keeps it in the body.
 */
function storable(body: string): string {
  return OPENING_FENCE.test(body) ? `\n${body}` : body;
}
