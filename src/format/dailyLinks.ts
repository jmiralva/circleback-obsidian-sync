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
// - Each time a meeting is linked, the plugin's own line for it is rewritten, in place, to exactly
//   what the plugin would write now: the current time, the full path of the note being linked, and
//   the current title. That fixes a link Obsidian shortened (a name only is ambiguous once another
//   file has the same name), one that points to a copy the user moved out of the sync folders
//   (which no longer counts), and a start time that changed. An own line that is already current
//   is not touched. Only a line that still reads as the plugin would write it now (same alias)
//   counts as an own line for this: the rest is the user's.
// - Any other line that links to the meeting, such as one the user edited or one from another
//   tool, counts as the meeting being present: nothing is added, and the line is never touched.
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
  const alias = cleanAlias(link.alias);
  const own: Array<{ index: number; time: string }> = [];
  let current: Line | null = null;
  let mentioned = false;
  for (let i = section.headingIndex + 1; i < section.end; i++) {
    if (section.verbatim[i]) continue;
    const existing = lines[i]?.text ?? "";
    const found = ownLine(existing, resolve);
    if (found?.target.id === link.id && found.alias === alias) {
      // The plugin's own line for this meeting, still reading as the plugin would write it now,
      // whichever of the meeting's files it links to. The first one is the one kept current.
      current ??= lines[i] ?? null;
      continue;
    }
    // Any other line that links to this very note, in whatever form: the user's line, nothing to do.
    if (linkTargets(existing, resolve).some((target) => target.path === notePath)) return;
    if (found === null) {
      if (linkTargets(existing, resolve).some((target) => target.id === link.id)) mentioned = true;
    } else if (found.target.id === link.id) {
      // The meeting, but not the plugin's title for it: the user's edit, or an older title.
      mentioned = true;
    } else {
      own.push({ index: i, time: found.time });
    }
  }

  if (current !== null) {
    // Assigning the text it already has changes nothing, so a line that is current stays as it is.
    current.text = text;
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
 * - When a line in the section links to the note a link is for, and it is not the plugin's own line
 *   for that meeting (one the user edited, or one from another tool), nothing changes for that link.
 * - Otherwise, the plugin's own line for the meeting, if there is one, is rewritten where it is to
 *   exactly what the plugin writes for this link now (the time, the path, the title as alias). An
 *   own line is one in the plugin's format that links to a file of the meeting (this note, a copy
 *   the user moved, or a shortened link) and whose alias is the one this link has (after
 *   cleaning). With several, the first is rewritten and the others stay. One that is already
 *   current stays byte for byte, and one is never moved to keep the time order.
 * - With no own line, any other line that links to the meeting, one the user edited, means
 *   nothing is added.
 * - Otherwise a new line goes before the first own line with a later time. With none, it goes
 *   after the section's last non-blank line (so a blank line before the next heading stays).
 * - With no such section, `heading` and the lines are appended at the end of the note.
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
