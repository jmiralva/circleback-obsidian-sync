// A meeting's notes as a block inside a daily note ("sections mode").
//
// The block sits between two marker lines:
//
//   %% circleback-start <id> %%
//   ## <title>
//   ...the meeting's notes, with their headings pushed below the title...
//   %% circleback-end <id> %%
//
// Writing the same meeting again replaces only what is between its markers. Everything else in
// the daily note is the user's and is never touched. To make that hold:
// - A marker is found only as a whole line, and a start marker is paired with the first end
//   marker after it only if no other marker (of any meeting) comes between. A start marker whose
//   end marker was deleted is ignored, so the replacement can never reach past it and swallow
//   the user's text or another meeting's block.
// - Marker text inside the notes is escaped (a zero-width space replaces the space after `%%`), so
//   notes can never close their own block or open a second one.
// - A code fence the notes leave open is closed, so the end marker is never hidden inside code.
// - Headings in the notes are moved below the meeting's heading, so they cannot end the section
//   early (the section runs to the next heading at its own level or higher).
//
// Pure: no Obsidian imports.
import {
  appendSection,
  findSection,
  insertLines,
  joinLines,
  lineEnding,
  normalizeHeading,
  scanFences,
  splitLines,
} from "./markdown";
import type { HeadingSpec, Line } from "./markdown";

const ZERO_WIDTH_SPACE = "​";
const MARKER_TEXT = "%% circleback-";
const ESCAPED_MARKER_TEXT = `%%${ZERO_WIDTH_SPACE}circleback-`;
const MAX_HEADING_LEVEL = 6;

// A heading line in the notes: indent, the hashes, and the rest of the line.
const BLOCK_HEADING = /^( {0,3})(#{1,6})(?=[ \t]|$)(.*)$/;

function escapeMarkers(text: string): string {
  return text.split(MARKER_TEXT).join(ESCAPED_MARKER_TEXT);
}

/** An id as it goes into a marker: no whitespace or `%`, so it cannot add a line or end the marker early. */
function markerId(id: string): string {
  return id.replace(/[\s%]/g, "_");
}

/** The title on one line, with the marker text escaped. */
function cleanTitle(title: string): string {
  return escapeMarkers(title.replace(/\s*[\r\n]+\s*/g, " ").trim());
}

/** The block's lines with leading and trailing blank lines removed (blank lines inside stay). */
function blockLines(block: string): string[] {
  const lines = block.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && (lines[0] ?? "").trim() === "") lines.shift();
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  return lines;
}

/**
 * Moves the block's headings so the shallowest sits at `target` and the rest keep their distance
 * from it, never deeper than level 6. `#` lines inside fenced code are not headings. A code fence
 * the block leaves open is closed.
 */
function fitHeadings(texts: string[], target: number): string[] {
  const lines: Line[] = texts.map((text) => ({ text, eol: "\n" }));
  const { fenced, open } = scanFences(lines);

  let shallowest = MAX_HEADING_LEVEL + 1;
  for (let i = 0; i < texts.length; i++) {
    if (fenced[i]) continue;
    const match = BLOCK_HEADING.exec(texts[i] ?? "");
    if (match) shallowest = Math.min(shallowest, (match[2] ?? "").length);
  }

  const shift = shallowest > MAX_HEADING_LEVEL ? 0 : target - shallowest;
  const fitted = texts.map((text, i) => {
    if (fenced[i]) return text;
    const match = BLOCK_HEADING.exec(text);
    if (!match) return text;
    const level = Math.min((match[2] ?? "").length + shift, MAX_HEADING_LEVEL);
    return `${match[1] ?? ""}${"#".repeat(level)}${match[3] ?? ""}`;
  });

  if (open) fitted.push(open.char.repeat(open.length));
  return fitted;
}

/** The lines between the markers: the meeting's heading, then its notes. */
function innerLines(spec: HeadingSpec, title: string, block: string): string[] {
  const meetingLevel = Math.min(spec.level + 1, MAX_HEADING_LEVEL);
  const target = Math.min(meetingLevel + 1, MAX_HEADING_LEVEL);
  const notes = fitHeadings(blockLines(escapeMarkers(block)), target);
  return [`${"#".repeat(meetingLevel)} ${cleanTitle(title)}`, ...notes];
}

// Any marker line, of any meeting.
const ANY_MARKER = /^%% circleback-(?:start|end) .* %%$/;

/**
 * The first complete pair of markers for this meeting: a start line, then its end line, with no
 * other marker line (of this or any other meeting) between them. Null when there is none.
 */
function findMarkerPair(lines: readonly Line[], start: string, end: string): { start: number; end: number } | null {
  const trimmed = (index: number): string => (lines[index]?.text ?? "").trim();
  for (let s = 0; s < lines.length; s++) {
    if (trimmed(s) !== start) continue;
    for (let e = s + 1; e < lines.length; e++) {
      if (trimmed(e) === end) return { start: s, end: e };
      if (ANY_MARKER.test(trimmed(e))) break;
    }
  }
  return null;
}

/**
 * Writes a meeting's block into the daily note's text.
 *
 * - If the meeting's markers are in the note, only what is between them is replaced.
 * - Otherwise the block goes at the end of the section under `sectionHeading` (after its last
 *   non-blank line, apart from what is above it by one blank line), or, with no such section,
 *   under a new `sectionHeading` at the end of the note.
 * - The meeting's own heading is one level below `sectionHeading` and carries `title`. The
 *   block's headings are shifted so the shallowest is one level below that, at most `######`.
 */
export function upsertMeetingBlock(text: string, sectionHeading: string, id: string, title: string, block: string): string {
  const spec = normalizeHeading(sectionHeading);
  if (spec === null) return text;

  const safeId = markerId(id);
  const start = `%% circleback-start ${safeId} %%`;
  const end = `%% circleback-end ${safeId} %%`;
  const inner = innerLines(spec, title, block);
  const lines = splitLines(text);

  const pair = findMarkerPair(lines, start, end);
  if (pair) {
    const eol = lines[pair.start]?.eol || lineEnding(text);
    lines.splice(pair.start + 1, pair.end - pair.start - 1, ...inner.map((line) => ({ text: line, eol })));
    return joinLines(lines);
  }

  const eol = lineEnding(text);
  const piece = [start, ...inner, end];
  const section = findSection(lines, spec);
  if (!section) {
    appendSection(lines, spec.line, piece, eol);
  } else {
    const hasContent = section.contentEnd > section.headingIndex + 1;
    insertLines(lines, section.contentEnd, hasContent ? ["", ...piece] : piece, eol);
  }
  return joinLines(lines);
}
