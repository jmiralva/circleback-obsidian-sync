// Where a meeting's note and transcript go, and what the files are called.
//
// Every function here is pure: the result depends only on the settings, the meeting's
// title and its start time (never on what is in the vault). Task 10 relies on that: it
// renames a note only when the note still sits at the path computed from the title and
// date the note was last synced with.
//
// Dates and times are the meeting's start in local time, so a 23:30 meeting is on the
// day it happened for the person who attended, not on the UTC day.
import { normalizePath } from "obsidian";
import { MEETING_START_FIELD } from "../api/constants";
import type { Meeting } from "../api/schemas";
import type { CirclebackSyncSettings, SubfolderPattern } from "../settings/types";
import { meetingLocal, type Moment } from "../util/time";

/**
 * What the path functions need from a meeting: its title and its start. The start sits
 * under the field `MEETING_START_FIELD` names, so a note's frontmatter (`title`, `created`)
 * can be passed as `{ name, createdAt }` without building a whole meeting.
 */
export type PathMeeting = Pick<Meeting, "name" | typeof MEETING_START_FIELD>;

const FALLBACK_TITLE = "Untitled meeting";
const MAX_TITLE_LENGTH = 200;

// Slashes, colons and the rest cannot appear in a file name on some platform; # ^ [ ] |
// break wikilinks, so they go too.
const UNSAFE_CHARACTERS = /[/\\:*?"<>|#^[\]]/g;
// Control characters and lone surrogates, neither of which a file system stores faithfully.
const UNSTORABLE_CHARACTERS = /[\p{Cc}\p{Cs}]/gu;
// A title of only underscores (what punctuation-only titles become) or blanks says nothing.
const EMPTY_TITLE = /^[_\s]*$/;
const LEADING_DOTS_AND_SPACE = /^[.\s]+/;

/**
 * Cuts text to at most `max` UTF-16 code units without splitting a surrogate pair.
 * Lone surrogates are removed before this is called, so a high surrogate at the cut
 * always has its partner just past it.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const lastKept = text.charCodeAt(max - 1);
  const splitsPair = lastKept >= 0xd800 && lastKept <= 0xdbff;
  return text.slice(0, splitsPair ? max - 1 : max);
}

/**
 * Makes a meeting title safe to use in a file name and in a wikilink.
 *
 * Each of `/ \ : * ? " < > | # ^ [ ]` becomes `_`, whitespace collapses to single spaces,
 * leading dots are dropped (a file named `.env` is hidden from Obsidian), and the result
 * is at most 200 characters. A title with nothing left, or only underscores, becomes
 * "Untitled meeting".
 */
export function sanitizeTitle(raw: string | null): string {
  if (raw === null) return FALLBACK_TITLE;
  // Whitespace first, so a newline or tab becomes one space instead of an underscore.
  const cleaned = raw
    .replace(/\s+/g, " ")
    .replace(UNSTORABLE_CHARACTERS, "_")
    .replace(UNSAFE_CHARACTERS, "_")
    .trim()
    .replace(LEADING_DOTS_AND_SPACE, "");
  const capped = truncate(cleaned, MAX_TITLE_LENGTH).trimEnd();
  return EMPTY_TITLE.test(capped) ? FALLBACK_TITLE : capped;
}

// Formats in English so that digits stay 0-9 whatever language Obsidian runs in. Some
// languages (Arabic, Persian, Hindi) would otherwise give "٢٠٢٦" in a file name, and the
// name would change if the user switched languages.
function format(start: Moment, template: string): string {
  return start.clone().locale("en").format(template);
}

/**
 * Replaces the variables in a user's pattern: `{title}`, `{date}` (YYYY-MM-DD),
 * `{time}` (HH-mm-ss), `{year}`, `{month}` (MM), `{day}` (DD) and `{quarter}` (Q1-Q4).
 *
 * `title` is inserted as given, so callers pass a sanitized title. Everything else in the
 * pattern, including text that looks like a variable but is not one, stays as typed. The
 * pattern is read in one pass, so a title that contains `{date}` is not expanded.
 */
export function expandPattern(pattern: string, title: string, start: Moment): string {
  return pattern.replace(/\{(title|date|time|year|month|day|quarter)\}/g, (match, name: string) => {
    switch (name) {
      case "title":
        return title;
      case "date":
        return format(start, "YYYY-MM-DD");
      case "time":
        return format(start, "HH-mm-ss");
      case "year":
        return format(start, "YYYY");
      case "month":
        return format(start, "MM");
      case "day":
        return format(start, "DD");
      case "quarter":
        return `Q${start.quarter()}`;
      default:
        return match;
    }
  });
}

const SUBFOLDER_PATTERNS: Record<Exclude<SubfolderPattern, "none" | "custom">, string> = {
  day: "{date}",
  month: "{year}-{month}",
  "year-month": "{year}/{month}",
  "year-quarter": "{year}/{quarter}",
};

/**
 * The subfolder (relative to the base folder) for a meeting: none, one per day, per month,
 * per year and month, per year and quarter, or the user's own pattern. A custom pattern is
 * used as typed, so a `/` in it makes nested folders; it has no title to use.
 */
export function subfolderFor(pattern: SubfolderPattern, custom: string, start: Moment): string {
  if (pattern === "none") return "";
  if (pattern === "custom") return expandPattern(custom, "", start);
  return expandPattern(SUBFOLDER_PATTERNS[pattern], "", start);
}

// The file name for a pattern. A pattern that expands to nothing (an emptied setting)
// would make a file called ".md", which Obsidian does not show, so the title stands in.
function fileNameFor(pattern: string, title: string, start: Moment): string {
  const stem = expandPattern(pattern, title, start).trim();
  return `${stem === "" ? title : stem}.md`;
}

function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter((part) => part.trim() !== "").join("/"));
}

/**
 * Where a meeting's note goes: the base folder (the custom folder, or the daily notes
 * folder passed in), then the subfolder, then the file named by the filename pattern.
 */
export function notePath(settings: CirclebackSyncSettings, meeting: PathMeeting, dailyFolder: string): string {
  const start = meetingLocal(meeting[MEETING_START_FIELD]);
  const base = settings.baseFolderType === "custom" ? settings.customBaseFolder : dailyFolder;
  const subfolder = subfolderFor(settings.subfolderPattern, settings.customSubfolderPattern, start);
  const fileName = fileNameFor(settings.filenamePattern, sanitizeTitle(meeting.name), start);
  return joinPath(base, subfolder, fileName);
}

/**
 * Where a meeting's transcript goes. Combined mode keeps it in the note, so the answer is
 * the note's own path. Same-location puts a transcript file in the note's folder (wherever
 * the note is now). Custom location uses the transcript folder settings.
 */
export function transcriptPath(settings: CirclebackSyncSettings, meeting: PathMeeting, notePathValue: string): string {
  if (settings.transcriptHandling === "combined") return notePathValue;
  const start = meetingLocal(meeting[MEETING_START_FIELD]);
  const fileName = fileNameFor(settings.transcriptFilenamePattern, sanitizeTitle(meeting.name), start);
  if (settings.transcriptHandling === "same-location") {
    const lastSlash = notePathValue.lastIndexOf("/");
    return joinPath(lastSlash < 0 ? "" : notePathValue.slice(0, lastSlash), fileName);
  }
  const subfolder = subfolderFor(
    settings.transcriptSubfolderPattern,
    settings.customTranscriptSubfolderPattern,
    start,
  );
  return joinPath(settings.customTranscriptBaseFolder, subfolder, fileName);
}

/**
 * The path to try when `path` is taken by another meeting with the same title: the start
 * date and time go before the `.md` extension (`-YYYY-MM-DD_HH-mm`), and from the second
 * candidate on a count follows (`-YYYY-MM-DD_HH-mm-2`) for meetings that also share a minute.
 */
export function collisionCandidate(path: string, start: Moment, n: number): string {
  const suffix = `-${format(start, "YYYY-MM-DD_HH-mm")}${n > 1 ? `-${n}` : ""}`;
  return path.endsWith(".md") ? `${path.slice(0, -3)}${suffix}.md` : `${path}${suffix}`;
}
