// The plugin's lines in a daily note: `- HH:MM - [[path|title]]` under a heading, one per meeting,
// linking to the meeting's note in the sync folders.
//
// The daily note is the user's, so these rules exist to keep their text safe:
// - A line is the plugin's own only if it has exactly the format above AND its link resolves to
//   a note with a `circleback_id`. Resolving is what lets a line survive Obsidian rewriting its
//   link when the note is renamed or moved.
// - Only own lines are ever removed, and only for the meetings asked for, and only while the
//   line still reads exactly as the plugin would write it now (same alias). A line the user edited
//   (extra text, a changed alias) is left alone, even though it still anchors the time order and
//   still counts as the meeting being present.
// - A meeting whose note is already linked in the section, in any form, gets nothing added.
// - An own line for the meeting that links to another of its files (a note the user moved out of
//   the sync folders, which no longer counts) is pointed at the note being linked, where it is,
//   but only while it reads as the plugin would write it now (same alias). Any other line that
//   links to the meeting, such as one the user edited, counts as the meeting being present:
//   nothing is added.
// - Nothing else in the note changes, down to line endings.
//
// Pure: the caller supplies `resolveLink`, which turns a link target into the note it points to.
import { appendSection, findSection, insertLines, joinLines, lineEnding, normalizeHeading, splitLines } from "./markdown";
import type { HeadingSpec, Line } from "./markdown";

export interface DailyLink {
  /** The meeting's id (`circleback_id`). */
  id: string;
  /** Local start time, "HH:MM". */
  time: string;
  /** The link target: the note's vault path without ".md". */
  linkpath: string;
  /** The text the link shows. `]` and `|` in it become `_`, and line breaks become spaces. */
  alias: string;
}

/**
 * A line to take out: the meeting's id and the alias the plugin would write for it now. The line
 * goes only if it is an own line for that meeting with exactly that alias, so a line whose alias
 * the user changed stays. (A meeting renamed upstream in the same run leaves its old line behind
 * as well, which is the safe direction.)
 */
export type DailyLinkRemoval = Pick<DailyLink, "id" | "alias">;

/** The note a link points to: its meeting (`circleback_id`) and its vault path. */
export interface LinkTarget {
  id: string;
  path: string;
}

/** Turns a link target into the note it points to, or null when that is not a note with a `circleback_id`. */
export type ResolveLink = (linkpath: string) => LinkTarget | null;

// `- HH:MM - [[path|alias]]` and nothing else on the line.
const OWN_LINE = /^- (\d{2}:\d{2}) - \[\[([^\]|]+)\|([^\]]*)\]\]$/;
// Any wikilink, with or without an alias: the target is group 1.
const WIKILINK = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

function cleanAlias(alias: string): string {
  return alias
    .replace(/\s*[\r\n]+\s*/g, " ")
    .replace(/[\]|]/g, "_")
    .trim();
}

function lineText(link: DailyLink): string {
  return `- ${link.time} - [[${link.linkpath}|${cleanAlias(link.alias)}]]`;
}

interface OwnLine {
  time: string;
  target: LinkTarget;
  alias: string;
}

function ownLine(text: string, resolve: ResolveLink): OwnLine | null {
  const match = OWN_LINE.exec(text);
  if (!match) return null;
  const target = resolve(match[2] ?? "");
  return target === null ? null : { time: match[1] ?? "", target, alias: match[3] ?? "" };
}

/** The meeting notes that the wikilinks on a line point to, whatever else the line says. */
function linkTargets(text: string, resolve: ResolveLink): LinkTarget[] {
  const targets: LinkTarget[] = [];
  for (const match of text.matchAll(WIKILINK)) {
    // "path#Heading" and "path^block" point at the same note as "path".
    const linkpath = (match[1] ?? "").split(/[#^]/)[0]?.trim() ?? "";
    const target = linkpath === "" ? null : resolve(linkpath);
    if (target !== null) targets.push(target);
  }
  return targets;
}

function removeOwnLines(
  lines: Line[],
  spec: HeadingSpec,
  aliases: ReadonlyMap<string, string>,
  resolve: ResolveLink,
): void {
  const section = findSection(lines, spec);
  if (!section) return;
  // From the bottom, so the indexes still to visit stay valid.
  for (let i = section.end - 1; i > section.headingIndex; i--) {
    if (section.verbatim[i]) continue;
    const own = ownLine(lines[i]?.text ?? "", resolve);
    if (own === null || aliases.get(own.target.id) !== own.alias) continue;
    const [removed] = lines.splice(i, 1);
    // A removed last line without a newline must not leave one on the line before it.
    const previous = lines[i - 1];
    if (removed?.eol === "" && previous) previous.eol = "";
  }
}

function addLink(lines: Line[], spec: HeadingSpec, link: DailyLink, resolve: ResolveLink, eol: string): void {
  const section = findSection(lines, spec);
  const text = lineText(link);
  if (!section) {
    appendSection(lines, spec.line, [text], eol);
    return;
  }

  // The note the new line links to, to tell it from the meeting's other files.
  const notePath = resolve(link.linkpath)?.path ?? null;
  const own: Array<{ index: number; time: string }> = [];
  let stale: Line | null = null;
  let mentioned = false;
  for (let i = section.headingIndex + 1; i < section.end; i++) {
    if (section.verbatim[i]) continue;
    const current = lines[i]?.text ?? "";
    const targets = linkTargets(current, resolve);
    // This very note is linked already, in whatever form: nothing to do.
    if (targets.some((target) => target.path === notePath)) return;
    const found = ownLine(current, resolve);
    if (found?.target.id === link.id) {
      // Only a line that still reads as the plugin would write it now: a changed alias is the user's edit.
      if (found.alias === cleanAlias(link.alias)) stale ??= lines[i] ?? null;
      else mentioned = true;
    } else if (found !== null) {
      own.push({ index: i, time: found.time });
    } else if (targets.some((target) => target.id === link.id)) {
      mentioned = true;
    }
  }

  if (stale !== null) {
    // The plugin's own line, linking to another file of this meeting (one moved out of the sync folders).
    stale.text = text;
    return;
  }
  // A line the user edited, linking to the meeting: their edit wins.
  if (mentioned) return;

  // In time order among the plugin's own lines. With none later, the end of the section: a line
  // inserted right after the last own line could land between it and the notes the user nested under it.
  const later = own.find((line) => line.time > link.time);
  insertLines(lines, later ? later.index : section.contentEnd, [text], eol);
}

/**
 * Adds a line for each link in `add` and removes the own lines of the meetings in `remove`,
 * in the section under `heading`. Returns the text unchanged when there is nothing to do.
 *
 * - A new line goes before the first own line with a later time. With none, it goes after the
 *   section's last non-blank line (so a blank line before the next heading stays).
 * - With no such section, `heading` and the lines are appended at the end of the note.
 * - When a line in the section already links to the note a link is for, by an own line or one
 *   the user edited, nothing changes for that link.
 * - Otherwise, the first own line for the meeting (linking to another of its files) whose alias is
 *   exactly the one this link has (after cleaning) is replaced, where it is, by the line for this
 *   link. With none, any other line that links to the meeting, one the user edited, means nothing
 *   is added.
 * - A line is removed only if it is an own line for a meeting in `remove` and its alias is exactly
 *   the one given there (after the same cleaning new lines get). Any other line stays.
 */
export function upsertLinkLines(
  text: string,
  heading: string,
  add: readonly DailyLink[],
  remove: readonly DailyLinkRemoval[],
  resolveLink: ResolveLink,
): string {
  const spec = normalizeHeading(heading);
  if (spec === null || (add.length === 0 && remove.length === 0)) return text;

  const cache = new Map<string, LinkTarget | null>();
  const resolve: ResolveLink = (linkpath) => {
    if (!cache.has(linkpath)) cache.set(linkpath, resolveLink(linkpath));
    return cache.get(linkpath) ?? null;
  };

  const lines = splitLines(text);
  const eol = lineEnding(text);
  if (remove.length > 0) {
    const aliases = new Map(remove.map(({ id, alias }) => [id, cleanAlias(alias)] as const));
    removeOwnLines(lines, spec, aliases, resolve);
  }
  for (const link of add) addLink(lines, spec, link, resolve, eol);
  return joinLines(lines);
}
