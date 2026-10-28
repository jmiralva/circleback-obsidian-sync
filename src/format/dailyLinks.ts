// The plugin's lines in a daily note: `- HH:MM - [[path|title]]` under a heading, one per meeting.
//
// The daily note is the user's, so these rules exist to keep their text safe:
// - A line is the plugin's own only if it has exactly the format above AND its link resolves to
//   a note with a `circleback_id`. Resolving is what lets a line survive Obsidian rewriting its
//   link when the note is renamed or moved.
// - Only own lines are ever removed, and only for the meetings asked for, and only while the
//   line still reads exactly as the plugin would write it now (same alias). A line the user edited
//   (extra text, a changed alias) is left alone, even though it still anchors the time order and
//   still counts as the meeting being present.
// - A meeting that is linked anywhere in the section, in any form, is not added again.
// - Nothing else in the note changes, down to line endings.
//
// Pure: the caller supplies `resolveId`, which turns a link target into a meeting id.
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

/** Turns a link target into the `circleback_id` of the note it points to, or null. */
export type ResolveId = (linkpath: string) => string | null;

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
  id: string;
  alias: string;
}

function ownLine(text: string, resolve: ResolveId): OwnLine | null {
  const match = OWN_LINE.exec(text);
  if (!match) return null;
  const id = resolve(match[2] ?? "");
  return id === null ? null : { time: match[1] ?? "", id, alias: match[3] ?? "" };
}

/** Whether any wikilink on the line points to the meeting, whatever else the line says. */
function linksTo(text: string, id: string, resolve: ResolveId): boolean {
  for (const match of text.matchAll(WIKILINK)) {
    // "path#Heading" and "path^block" point at the same note as "path".
    const target = (match[1] ?? "").split(/[#^]/)[0]?.trim() ?? "";
    if (target !== "" && resolve(target) === id) return true;
  }
  return false;
}

function removeOwnLines(
  lines: Line[],
  spec: HeadingSpec,
  aliases: ReadonlyMap<string, string>,
  resolve: ResolveId,
): void {
  const section = findSection(lines, spec);
  if (!section) return;
  // From the bottom, so the indexes still to visit stay valid.
  for (let i = section.end - 1; i > section.headingIndex; i--) {
    if (section.verbatim[i]) continue;
    const own = ownLine(lines[i]?.text ?? "", resolve);
    if (own === null || aliases.get(own.id) !== own.alias) continue;
    const [removed] = lines.splice(i, 1);
    // A removed last line without a newline must not leave one on the line before it.
    const previous = lines[i - 1];
    if (removed?.eol === "" && previous) previous.eol = "";
  }
}

function addLink(lines: Line[], spec: HeadingSpec, link: DailyLink, resolve: ResolveId, eol: string): void {
  const section = findSection(lines, spec);
  const text = lineText(link);
  if (!section) {
    appendSection(lines, spec.line, [text], eol);
    return;
  }

  const own: Array<{ index: number; time: string }> = [];
  for (let i = section.headingIndex + 1; i < section.end; i++) {
    if (section.verbatim[i]) continue;
    const current = lines[i]?.text ?? "";
    if (linksTo(current, link.id, resolve)) return;
    const found = ownLine(current, resolve);
    if (found !== null) own.push({ index: i, time: found.time });
  }

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
 * - A meeting already linked anywhere in the section, by an own line or one the user edited, gets nothing added.
 * - A line is removed only if it is an own line for a meeting in `remove` and its alias is exactly
 *   the one given there (after the same cleaning new lines get). Any other line stays.
 */
export function upsertLinkLines(
  text: string,
  heading: string,
  add: readonly DailyLink[],
  remove: readonly DailyLinkRemoval[],
  resolveId: ResolveId,
): string {
  const spec = normalizeHeading(heading);
  if (spec === null || (add.length === 0 && remove.length === 0)) return text;

  const cache = new Map<string, string | null>();
  const resolve: ResolveId = (linkpath) => {
    if (!cache.has(linkpath)) cache.set(linkpath, resolveId(linkpath));
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
