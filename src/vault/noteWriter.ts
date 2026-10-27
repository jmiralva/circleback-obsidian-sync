// Writes a meeting's note and transcript into the vault, and keeps them up to date.
//
// This is the code that touches the user's notes, so it keeps three promises:
// - One file per meeting and kind. Files are found by (circleback_id, circleback_kind) through
//   the index, wherever they were moved or renamed. A file of this meeting that the index has
//   not seen yet (synced in from another device mid-run) is taken over, never copied.
// - The user's frontmatter survives. It changes only through processFrontMatter, key by key,
//   and the only keys ever removed are ones the plugin writes on that kind of file.
// - A file the user filed stays put. A file is renamed only while it sits exactly where the
//   plugin would have put it under its previous title and date, so neither a move by the user
//   nor a change of folder settings ever moves it.
//
// The transcript is written before the note, and the note's frontmatter (which carries
// `circleback_updated`) is the very last write. A failure anywhere leaves the note looking out
// of date, so the next run tries the meeting again.
import { TFile, normalizePath } from "obsidian";
import type { App, TAbstractFile } from "obsidian";
import { MEETING_START_FIELD } from "../api/constants";
import type { Meeting, TranscriptSegment } from "../api/schemas";
import { REWRITTEN_KEYS, buildFields, meetingTitle, type FileKind } from "../format/fields";
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
  /** The note (the combined file in combined mode). Null in sections mode, which has no note file. */
  note: TFile | null;
  /** The separate transcript file, written now or kept from an earlier run. Null in combined mode. */
  transcript: TFile | null;
  /** The note's `created` before this write, to move its daily-note line. Null for a new note. */
  oldStart: string | null;
  /** Whether anything in the vault was written. */
  changed: boolean;
};

/** Where one file of a meeting is to be after a write. */
interface Placement {
  /** The meeting's existing file of this kind, or null when one is to be created. */
  file: TFile | null;
  /** That file's frontmatter as the index holds it (the plugin's last write); empty for a new file. */
  frontmatter: Record<string, unknown>;
  /** Where the file is to be: where it already is, a rename target, or where to create it. */
  path: string;
}

/** The note and transcript paths a transcript's location is worked out from. */
interface NotePaths {
  /** Where the note is before this write: the transcript's previous path is computed beside it. */
  before: string;
  /** Where the note is after this write: a same-location transcript goes beside it. */
  after: string;
}

// The fence `splitFrontmatter` takes for the start of a frontmatter block.
const OPENING_FENCE = /^---[ \t]*\r?\n/;

export class NoteWriter {
  constructor(
    private readonly app: App,
    private readonly index: MeetingIndex,
  ) {}

  /**
   * Whether the vault already holds this version of the meeting, so there is nothing to write
   * (and no transcript to fetch). This is the rule `write` skips by. Never true when forced.
   *
   * With files, the note (or combined file) has to exist with a `circleback_updated` no older
   * than the meeting's `updatedAt`, and when `expectTranscript` is true the transcript file has
   * to exist too (in combined mode the combined file is the transcript). In sections mode only
   * the transcript is a file, so the answer is true only when a transcript is expected and its
   * file is current; the engine rewrites the daily-note block otherwise.
   */
  isCurrent(m: Meeting, ctx: WriteContext, expectTranscript: boolean): boolean {
    if (ctx.force) return false;
    const combined = ctx.settings.transcriptHandling === "combined";
    if (ctx.settings.saveAs === "sections") {
      return expectTranscript && !combined && this.fileIsCurrent(this.liveFile(m.id, "transcript"), m);
    }
    if (!this.fileIsCurrent(this.liveFile(m.id, combined ? "combined" : "note"), m)) return false;
    return !expectTranscript || combined || this.liveFile(m.id, "transcript") !== null;
  }

  /**
   * Writes a meeting: its transcript file first (when `transcript` is not null and transcripts
   * are separate files), then its note. A null transcript (turned off, or not allowed) means
   * none is expected, and an existing transcript file is kept and still linked.
   *
   * Nothing is written when `isCurrent` says the vault is up to date. In sections mode only the
   * transcript file is written; the daily-note block is the engine's job.
   */
  async write(m: Meeting, transcript: TranscriptSegment[] | null, ctx: WriteContext): Promise<WriteResult> {
    if (this.isCurrent(m, ctx, transcript !== null)) return this.unchanged(m, ctx);
    if (ctx.settings.saveAs === "sections") {
      if (transcript === null || ctx.settings.transcriptHandling === "combined") return this.unchanged(m, ctx);
      // With no note, a same-location transcript goes in the daily notes folder. Only the
      // folder of this path is used.
      const beside = normalizePath(`${ctx.dailyFolder}/note.md`);
      const file = await this.writeTranscript(m, transcript, ctx, { before: beside, after: beside });
      return { note: null, transcript: file, oldStart: null, changed: true };
    }
    return this.writeFiles(m, transcript, ctx);
  }

  private async writeFiles(m: Meeting, transcript: TranscriptSegment[] | null, ctx: WriteContext): Promise<WriteResult> {
    const { settings } = ctx;
    const combined = settings.transcriptHandling === "combined";
    const kind: FileKind = combined ? "combined" : "note";

    // The note's place is settled first, so that the transcript can link to it.
    const note = await this.place(
      m,
      kind,
      notePath(settings, m, ctx.dailyFolder),
      (previous) => notePath(settings, previous, ctx.dailyFolder),
      [],
    );

    let transcriptFile: TFile | null = null;
    if (!combined) {
      transcriptFile =
        transcript === null
          ? this.liveFile(m.id, "transcript")
          : await this.writeTranscript(m, transcript, ctx, { before: note.file?.path ?? note.path, after: note.path }, note.path);
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

  private async writeTranscript(
    m: Meeting,
    segs: TranscriptSegment[],
    ctx: WriteContext,
    notePaths: NotePaths,
    linkTo?: string,
  ): Promise<TFile> {
    const { settings } = ctx;
    const placement = await this.place(
      m,
      "transcript",
      transcriptPath(settings, m, notePaths.after),
      (previous) => transcriptPath(settings, previous, notePaths.before),
      // The note may not be at its path yet; the transcript must not take it.
      linkTo === undefined ? [] : [linkTo],
    );
    const body = this.transcriptText(m, segs, ctx);
    return this.writeFile(placement, "transcript", body, this.fields(m, ctx, "transcript", body, linkTo), ctx);
  }

  /** What `write` returns when it writes nothing: the files the meeting already has. */
  private unchanged(m: Meeting, ctx: WriteContext): WriteResult {
    const combined = ctx.settings.transcriptHandling === "combined";
    const note = ctx.settings.saveAs === "sections" ? null : this.liveFile(m.id, combined ? "combined" : "note");
    return {
      note,
      transcript: combined ? null : this.liveFile(m.id, "transcript"),
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
   * Decides where a meeting's file of one kind is to be.
   *
   * An existing file stays where it is, unless it is still exactly at `previousPathOf` its
   * previous title and date and the meeting now computes to a different path: then it moves
   * there (or to the first free collision candidate). A new file goes to `computed`, or the first
   * collision candidate that is free.
   *
   * @param computed Where the plugin puts this file now.
   * @param previousPathOf Where the plugin would have put it under the title and date it was last written with.
   * @param reserved Paths that count as taken although nothing is there yet.
   */
  private async place(
    m: Meeting,
    kind: FileKind,
    computed: string,
    previousPathOf: (previous: PathMeeting) => string,
    reserved: readonly string[],
  ): Promise<Placement> {
    const start = meetingLocal(m[MEETING_START_FIELD]);
    let file = this.liveFile(m.id, kind);
    if (file === null) {
      const spot = await this.newSpot(m.id, kind, computed, start, reserved);
      if (typeof spot === "string") return { file: null, frontmatter: {}, path: spot };
      file = spot;
    }

    const frontmatter = this.index.frontmatter(file) ?? {};
    const previous = previousMeeting(frontmatter);
    const stays = previous === null || file.path !== previousPathOf(previous) || computed === file.path;
    return { file, frontmatter, path: stays ? file.path : this.freePath(computed, file, start, reserved) };
  }

  /**
   * The first free path among `computed` and its collision candidates. If one of them holds a
   * file of this meeting and kind that the index did not know, that file is returned instead,
   * to be updated where it is.
   */
  private async newSpot(
    id: string,
    kind: FileKind,
    computed: string,
    start: Moment,
    reserved: readonly string[],
  ): Promise<string | TFile> {
    for (let n = 0; ; n++) {
      const candidate = n === 0 ? computed : collisionCandidate(computed, start, n);
      if (isReserved(candidate, reserved)) continue;
      const occupant = this.occupant(candidate, null);
      if (occupant === null) return candidate;
      if (occupant instanceof TFile && (await this.claim(occupant, id, kind))) return occupant;
    }
  }

  /** The first free path among `computed` and its collision candidates, for moving `self` there. */
  private freePath(computed: string, self: TFile, start: Moment, reserved: readonly string[]): string {
    for (let n = 0; ; n++) {
      const candidate = n === 0 ? computed : collisionCandidate(computed, start, n);
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

  /** Whether a file the index did not know is this meeting's file of this kind. If so, the index learns it. */
  private async claim(file: TFile, id: string, kind: FileKind): Promise<boolean> {
    let frontmatter: Record<string, unknown> | null;
    try {
      frontmatter = await readFrontmatter(this.app, file);
    } catch (error) {
      logger.warn(`Could not read ${file.path}; treating its path as taken.`, error);
      return false;
    }
    if (frontmatter?.circleback_id !== id || frontmatter.circleback_kind !== kind) return false;
    this.index.upsert(file, frontmatter);
    return true;
  }

  /**
   * The meeting's file of this kind: the first the index lists (oldest first) that is still in
   * the vault. A file deleted or trashed since the index saw it is dropped from the index.
   */
  private liveFile(id: string, kind: FileKind): TFile | null {
    for (const file of this.index.find(id, kind)) {
      if (this.app.vault.getAbstractFileByPath(file.path) === file) return file;
      this.index.forget(file);
    }
    return null;
  }

  private fileIsCurrent(file: TFile | null, m: Meeting): boolean {
    if (file === null) return false;
    const written = this.index.frontmatter(file)?.circleback_updated;
    // Compared as instants: the same moment can be written with different offsets.
    return typeof written === "string" && Date.parse(written) >= Date.parse(m.updatedAt);
  }

  /** Creates, or renames and updates, the file a placement describes. */
  private async writeFile(
    placement: Placement,
    kind: FileKind,
    body: string,
    fields: Record<string, unknown>,
    ctx: WriteContext,
  ): Promise<TFile> {
    const { file, path } = placement;
    if (file === null) return this.createFile(path, kind, body, fields, ctx.now());

    if (file.path !== path) {
      await this.ensureFolders(path);
      await this.app.fileManager.renameFile(file, path);
      this.index.upsert(file, placement.frontmatter);
    }
    await this.replaceBody(file, body);
    const removable = removableKeys(kind);
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

  /** Creates the folders above `path` that do not exist yet: create and rename need them. */
  private async ensureFolders(path: string): Promise<void> {
    const segments = path.split("/").slice(0, -1);
    for (let depth = 1; depth <= segments.length; depth++) {
      const folder = segments.slice(0, depth).join("/");
      if (this.app.vault.getAbstractFileByPath(folder) === null) await this.app.vault.createFolder(folder);
    }
  }
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
