// Daily notes: finding or creating the note for a day, and writing a meeting into it, either as
// a one-line link or as a block of notes between markers.
//
// The daily note belongs to the user. This file only decides which note and when; what is written
// into it, and what is kept, is decided by the pure code in `format/dailyLinks` and
// `format/sections`. Every write reads the text, works out the new text, and calls `vault.process`
// only when the two differ (and works it out again from the text `process` hands over, so an edit
// made in between is never overwritten).
//
// Dates are the meeting's start in local time, so a 23:30 meeting is on the day it happened.
import { moment, normalizePath } from "obsidian";
import type { App, TFile } from "obsidian";
import { MEETING_START_FIELD } from "../api/constants";
import type { Meeting } from "../api/schemas";
import { upsertLinkLines, type DailyLink, type ResolveLink } from "../format/dailyLinks";
import { meetingTitle } from "../format/fields";
import { normalizeHeading } from "../format/markdown";
import { upsertMeetingBlock } from "../format/sections";
import type { CirclebackSyncSettings, CreateMissingDailyNotes } from "../settings/types";
import { logger } from "../util/logger";
import { meetingLocal, type Moment } from "../util/time";
import type { MeetingIndex } from "./meetingIndex";

export interface DailyNoteConfig {
  /** Vault folder for daily notes. "" is the vault root. */
  folder: string;
  /** moment.js format for the file name. May contain "/" to put notes in dated subfolders. */
  format: string;
  /** Vault path of the template file, with or without ".md". "" for none. */
  template: string;
}

const DEFAULT_FORMAT = "YYYY-MM-DD";
const PERIODIC_NOTES_ID = "periodic-notes";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The parsed JSON file, or undefined when it does not exist or cannot be read (the latter is logged). */
async function readJson(app: App, path: string): Promise<unknown> {
  try {
    if (!(await app.vault.adapter.exists(path))) return undefined;
    return JSON.parse(await app.vault.adapter.read(path)) as unknown;
  } catch (error) {
    logger.warn(`Could not read ${path}; ignoring it.`, error);
    return undefined;
  }
}

function setting(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function configFrom(settings: Record<string, unknown>): DailyNoteConfig {
  return {
    folder: setting(settings.folder, ""),
    format: setting(settings.format, DEFAULT_FORMAT),
    template: setting(settings.template, ""),
  };
}

/**
 * Where the daily notes are, how they are named, and which template they start from.
 *
 * Periodic Notes is in charge when it is in the list of enabled community plugins and its daily
 * notes are switched on. Otherwise the core Daily Notes settings apply, and with neither the
 * defaults do: the vault root, `YYYY-MM-DD`, and no template. A missing, empty, or unusable
 * field falls back on its own. Config files are read through the vault adapter under the
 * vault's config folder.
 */
export async function readDailyNoteConfig(app: App): Promise<DailyNoteConfig> {
  const configDir = app.vault.configDir;

  const enabledPlugins = await readJson(app, normalizePath(`${configDir}/community-plugins.json`));
  if (Array.isArray(enabledPlugins) && enabledPlugins.includes(PERIODIC_NOTES_ID)) {
    const periodic = await readJson(app, normalizePath(`${configDir}/plugins/${PERIODIC_NOTES_ID}/data.json`));
    const daily = isRecord(periodic) ? periodic.daily : undefined;
    if (isRecord(daily) && daily.enabled === true) return configFrom(daily);
  }

  const core = await readJson(app, normalizePath(`${configDir}/daily-notes.json`));
  return configFrom(isRecord(core) ? core : {});
}

function localDay(date: Moment): string {
  return date.clone().local().format("YYYY-MM-DD");
}

/** Whether a missing daily note for `date` may be created, under the "create missing daily notes" setting. */
export function shouldCreate(mode: CreateMissingDailyNotes, date: Moment, now: Moment): boolean {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return localDay(date) === localDay(now);
}

// `{{date}}`, `{{date:FORMAT}}`, `{{time}}` and `{{title}}`, spelled the way core Daily Notes accepts them.
const TEMPLATE_TOKEN = /\{\{\s*(date|time|title)\s*(?::([^}]+))?\}\}/gi;

interface TemplateValues {
  /** The note's date, in local time. */
  date: Moment;
  /** The daily note format, for a bare `{{date}}`. */
  format: string;
  /** The note's file name without ".md". */
  title: string;
  now: Moment;
}

/**
 * Fills in `{{date}}`, `{{date:FORMAT}}`, `{{time}}` (the current time, HH:mm) and `{{title}}`.
 * Everything else, including Templater's `<% %>` tags and the other tokens core Daily Notes knows,
 * is copied as it is. Each token is replaced once; a replacement is never searched for tokens.
 */
function fillTemplate(template: string, values: TemplateValues): string {
  return template.replace(TEMPLATE_TOKEN, (token: string, name: string, argument: string | undefined) => {
    switch (name.toLowerCase()) {
      case "date":
        return values.date.format(argument?.trim() || values.format);
      case "time":
        return argument === undefined ? values.now.format("HH:mm") : token;
      case "title":
        return argument === undefined ? values.title : token;
      default:
        return token;
    }
  });
}

/** The template's text. Empty when none is set, and (with a warning) when the file is missing. */
async function readTemplate(app: App, template: string): Promise<string> {
  if (template === "") return "";
  const path = normalizePath(template.toLowerCase().endsWith(".md") ? template : `${template}.md`);
  const file = app.vault.getFileByPath(path);
  if (file === null) {
    logger.warn(`The daily note template ${path} was not found, so the new daily note starts empty.`);
    return "";
  }
  return app.vault.cachedRead(file);
}

async function ensureFolder(app: App, path: string): Promise<void> {
  if (path === "" || path === "/") return;
  let current = "";
  for (const segment of path.split("/")) {
    current = current === "" ? segment : `${current}/${segment}`;
    if (app.vault.getFolderByPath(current) !== null) continue;
    try {
      await app.vault.createFolder(current);
    } catch (error) {
      // Created in the meantime (by a sync service, say) is fine.
      if (app.vault.getFolderByPath(current) === null) throw error;
    }
  }
}

/**
 * The daily note for `date` (a local-time moment), or null when there is none and `create` is
 * false. When `create` is true and the note is missing, it is created from the template, with its
 * folders. `now` supplies `{{time}}`.
 *
 * A note that exists on disk but that Obsidian has not indexed yet (a sync service is still
 * delivering it) makes creating it fail, and the failure is thrown: guessing would risk a copy.
 */
export async function getDailyNote(
  app: App,
  date: Moment,
  create: boolean,
  now: Moment = moment.utc().local(),
): Promise<TFile | null> {
  const config = await readDailyNoteConfig(app);
  const name = date.format(config.format);
  const path = normalizePath(`${config.folder}/${name}.md`);

  const existing = app.vault.getFileByPath(path);
  if (existing !== null) return existing;
  if (!create) return null;

  const template = await readTemplate(app, config.template);
  const content = fillTemplate(template, { date, format: config.format, title: name.split("/").pop() ?? name, now });
  await ensureFolder(app, path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
  try {
    return await app.vault.create(path, content);
  } catch (error) {
    const appeared = app.vault.getFileByPath(path);
    if (appeared !== null) return appeared;
    throw error;
  }
}

function idOf(frontmatter: Record<string, unknown> | null | undefined): string | null {
  const id = frontmatter?.circleback_id;
  return typeof id === "string" && id !== "" ? id : null;
}

export class DailyNotes {
  /**
   * @param index Lets a link be matched to its meeting before the metadata cache has caught up with a
   * note that was created or renamed in this run. Optional: without it only the cache is used.
   */
  constructor(
    private readonly app: App,
    private readonly index?: MeetingIndex,
  ) {}

  /**
   * Puts a `- HH:MM - [[note|title]]` line for the meeting in the daily note of the day it started
   * (local time), under the link heading. The plugin's own line for the meeting, while unedited,
   * that links to another of its files (one the user moved out of the sync folders) is pointed at
   * `note` instead (see `upsertLinkLines`). Does nothing unless linking is on. A missing note for the new day is
   * created only as `createMissingDailyNotes` allows.
   *
   * When `oldStart`, the start the note had before this sync, is on another day, the meeting's own
   * line is then removed from that day's note, if that note exists (it is never created to remove a
   * line). The line goes only while it still reads as the plugin wrote it, with the meeting's current
   * title as its alias: a line the user edited stays. The removal comes after the add, so a failed
   * add leaves the old line in place. A failure is thrown.
   */
  async linkMeeting(note: TFile, m: Meeting, oldStart: string | null, s: CirclebackSyncSettings, now: Moment): Promise<void> {
    if (!s.linkFromDailyNotes) return;
    const title = meetingTitle(m);
    if (normalizeHeading(s.dailyNoteLinkHeading) === null) {
      logger.warn(`Not linking "${title}" from the daily note: the daily note link heading setting is empty.`);
      return;
    }
    const start = this.startOf(m, title);
    if (start === null) return;

    // Add to the new day first, then take the line off the old one: if the add fails, the old line
    // is still there, and the next run (which calls this again) finishes the move.
    const file = await getDailyNote(this.app, start, shouldCreate(s.createMissingDailyNotes, start, now), now);
    if (file !== null) {
      const link: DailyLink = {
        id: m.id,
        time: start.format("HH:mm"),
        linkpath: note.path.replace(/\.md$/i, ""),
        alias: title,
      };
      const resolve = this.linkResolver(file.path);
      await this.update(file, (text) => upsertLinkLines(text, s.dailyNoteLinkHeading, [link], [], resolve));
    }

    if (oldStart !== null) {
      const before = meetingLocal(oldStart);
      if (before.isValid() && localDay(before) !== localDay(start)) {
        await this.removeLine(before, file, m.id, title, s.dailyNoteLinkHeading);
      }
    }
  }

  /**
   * Writes the meeting's notes (`block`, Markdown) into the section of the daily note of the day it
   * started (local time), between its markers. Only text between the meeting's markers is replaced.
   * A missing note for that day is created only as `createMissingDailyNotes` allows. A meeting whose
   * start moved to another day is not moved: its old block stays where it is. A failure is thrown.
   *
   * Resolves to whether the daily note changed: false when the block was already there as it is,
   * and when nothing could be written (no heading set, no usable start, no note and none created).
   */
  async writeSection(m: Meeting, block: string, s: CirclebackSyncSettings, now: Moment): Promise<boolean> {
    const title = meetingTitle(m);
    if (normalizeHeading(s.dailyNoteSectionHeading) === null) {
      logger.warn(`Not writing "${title}" into the daily note: the daily note section heading setting is empty.`);
      return false;
    }
    const start = this.startOf(m, title);
    if (start === null) return false;

    const file = await getDailyNote(this.app, start, shouldCreate(s.createMissingDailyNotes, start, now), now);
    if (file === null) return false;
    return this.update(file, (text) => upsertMeetingBlock(text, s.dailyNoteSectionHeading, m.id, title, block));
  }

  private startOf(m: Meeting, title: string): Moment | null {
    const start = meetingLocal(m[MEETING_START_FIELD]);
    if (start.isValid()) return start;
    logger.warn(`Not putting "${title}" in a daily note: its start time could not be read.`);
    return null;
  }

  /**
   * Removes the meeting's own line, if unedited, from an existing daily note. Not from `except`, the
   * note it was just added to: a date format coarser than a day (a monthly note) puts the old and the
   * new day in one file, and the line there is the one just written.
   */
  private async removeLine(date: Moment, except: TFile | null, id: string, alias: string, heading: string): Promise<void> {
    const file = await getDailyNote(this.app, date, false);
    if (file === null || file === except) return;
    const resolve = this.linkResolver(file.path);
    await this.update(file, (text) => upsertLinkLines(text, heading, [], [{ id, alias }], resolve));
  }

  /**
   * The note a link in the given daily note points to, and its `circleback_id`: from the cache
   * first, then the index. A note outside the sync folders still resolves through the cache, so a
   * line linking to a copy the user moved out is still known as that meeting's.
   */
  private linkResolver(dailyNotePath: string): ResolveLink {
    return (linkpath) => {
      const target = this.app.metadataCache.getFirstLinkpathDest(linkpath, dailyNotePath);
      if (target === null) return null;
      const id = idOf(this.app.metadataCache.getFileCache(target)?.frontmatter) ?? idOf(this.index?.frontmatter(target));
      return id === null ? null : { id, path: target.path };
    };
  }

  /** Reads the file and writes it back through `vault.process`, only when the new text differs. Says whether it wrote. */
  private async update(file: TFile, transform: (text: string) => string): Promise<boolean> {
    const current = await this.app.vault.read(file);
    if (transform(current) === current) return false;
    await this.app.vault.process(file, transform);
    return true;
  }
}
