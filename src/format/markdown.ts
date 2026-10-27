// The small amount of Markdown knowledge that the daily-note code shares: splitting a note into
// lines without losing a byte, finding headings (skipping fenced code), and finding where a
// section starts and ends.
//
// Pure: no Obsidian imports. Everything the daily-note code writes goes into a note the user
// also edits, so nothing here may change a line it was not asked to change. That is why a note
// is split into lines that remember their own line ending, and why joining them back gives
// exactly the text that went in.

/** One line of a note and the line ending that followed it ("" for a last line with none). */
export interface Line {
  text: string;
  eol: string;
}

/** Splits text into lines, each with its own ending ("\n" or "\r\n"). `joinLines` is the exact inverse. */
export function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let position = 0;
  while (position < text.length) {
    const newline = text.indexOf("\n", position);
    if (newline === -1) {
      lines.push({ text: text.slice(position), eol: "" });
      break;
    }
    const crlf = newline > position && text[newline - 1] === "\r";
    lines.push({ text: text.slice(position, crlf ? newline - 1 : newline), eol: crlf ? "\r\n" : "\n" });
    position = newline + 1;
  }
  return lines;
}

export function joinLines(lines: readonly Line[]): string {
  return lines.map((line) => line.text + line.eol).join("");
}

/** The line ending to use for lines we add: CRLF if the note has any, else LF. */
export function lineEnding(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Inserts lines before `lines[at]` (at the very end when `at` is `lines.length`). When that is
 * after a last line that had no ending, the line gets one and the final inserted line takes its
 * place as the one without, so a note that did not end in a newline still does not.
 */
export function insertLines(lines: Line[], at: number, texts: readonly string[], eol: string): void {
  if (texts.length === 0) return;
  const inserted: Line[] = texts.map((text) => ({ text, eol }));
  const previous = lines[at - 1];
  if (at === lines.length && previous !== undefined && previous.eol === "") {
    previous.eol = eol;
    const last = inserted[inserted.length - 1];
    if (last) last.eol = "";
  }
  lines.splice(at, 0, ...inserted);
}

/**
 * Adds a new section (a blank line, the heading, then `body`) at the end of the note. The blank
 * line is skipped when the note is empty or already ends in one. The note ends in a newline after.
 */
export function appendSection(lines: Line[], headingLine: string, body: readonly string[], eol: string): void {
  const last = lines[lines.length - 1];
  if (last !== undefined && last.eol === "") last.eol = eol;
  const needsBlank = last !== undefined && last.text.trim() !== "";
  insertLines(lines, lines.length, [...(needsBlank ? [""] : []), headingLine, ...body], eol);
}

export interface Heading {
  level: number;
  text: string;
}

// Up to three spaces of indent, 1 to 6 #, then a space or the end of the line. "#tag" is not a heading.
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
// An optional closing run of #, as in "## Meetings ##".
const CLOSING_HASHES = /(?:^|[ \t]+)#+[ \t]*$/;

/** Reads an ATX heading line ("## Meetings"), or null for any other line. */
export function parseHeading(line: string): Heading | null {
  const match = ATX_HEADING.exec(line);
  if (!match) return null;
  const hashes = match[1] ?? "";
  const text = (match[2] ?? "").replace(CLOSING_HASHES, "").trim();
  return { level: hashes.length, text };
}

export interface HeadingSpec extends Heading {
  /** The heading as it is written into a note. */
  line: string;
}

/**
 * Turns a heading setting ("## Meetings") into the heading to look for and to write. A setting
 * typed without the space ("#Meetings") or without any # ("Meetings") still works, as a level 1
 * heading in the second case. A setting with no text gives null: there is nothing to look for.
 */
export function normalizeHeading(setting: string): HeadingSpec | null {
  const flat = setting.replace(/\s+/g, " ").trim();
  const match = /^(#{1,6})\s*(.*)$/.exec(flat);
  const level = match ? (match[1] ?? "").length : 1;
  const text = (match ? (match[2] ?? "") : flat).replace(CLOSING_HASHES, "").trim();
  return text === "" ? null : { level, text, line: `${"#".repeat(level)} ${text}` };
}

// A code fence: up to three spaces, then three or more backticks or tildes.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export interface OpenFence {
  char: string;
  length: number;
}

/**
 * Which lines are part of a fenced code block (fences included), and the fence still open at
 * the end of the text, if any. Headings and links inside code are not headings and links.
 */
export function scanFences(lines: readonly Line[]): { fenced: boolean[]; open: OpenFence | null } {
  const fenced: boolean[] = [];
  let open: OpenFence | null = null;
  for (const { text } of lines) {
    const match = FENCE.exec(text);
    const marker = match?.[1] ?? "";
    const info = match?.[2] ?? "";
    if (open === null) {
      // A backtick fence's info string cannot hold a backtick, or it is inline code.
      const opens = match !== null && !(marker.startsWith("`") && info.includes("`"));
      if (opens) open = { char: marker.charAt(0), length: marker.length };
      fenced.push(opens);
    } else {
      fenced.push(true);
      if (match !== null && marker.startsWith(open.char) && marker.length >= open.length && info.trim() === "") open = null;
    }
  }
  return { fenced, open };
}

export interface Section {
  /** Index of the heading line. */
  headingIndex: number;
  /** Index of the next heading of the same or a higher level, or the number of lines. */
  end: number;
  /** One past the section's last non-blank line (just past the heading for an empty section). */
  contentEnd: number;
  /** For every line of the note, whether it is fenced code or frontmatter, which hold no headings and no links. */
  verbatim: boolean[];
}

const FRONTMATTER_FENCE = /^---[ \t]*$/;

/** Index of the line that closes a frontmatter block at the top of the note, or -1 when there is none. */
function frontmatterEnd(lines: readonly Line[]): number {
  if (!FRONTMATTER_FENCE.test(lines[0]?.text ?? "")) return -1;
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_FENCE.test(lines[i]?.text ?? "")) return i;
  }
  return -1;
}

/**
 * Finds the first heading in the note that matches `spec` (same level, same text ignoring case
 * and spacing) outside fenced code and frontmatter (a `# comment` in YAML is not a heading). The
 * section runs to the next heading of the same or a higher level, so deeper headings belong to it.
 */
export function findSection(lines: readonly Line[], spec: HeadingSpec): Section | null {
  const verbatim = scanFences(lines).fenced;
  const frontmatter = frontmatterEnd(lines);
  for (let i = 0; i <= frontmatter; i++) verbatim[i] = true;
  const wanted = spec.text.replace(/\s+/g, " ").toLowerCase();
  let headingIndex = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (verbatim[i]) continue;
    const heading = parseHeading(lines[i]?.text ?? "");
    if (heading === null) continue;
    if (headingIndex === -1) {
      if (heading.level === spec.level && heading.text.replace(/\s+/g, " ").toLowerCase() === wanted) headingIndex = i;
    } else if (heading.level <= spec.level) {
      end = i;
      break;
    }
  }
  if (headingIndex === -1) return null;

  let contentEnd = headingIndex + 1;
  for (let i = end - 1; i > headingIndex; i--) {
    if ((lines[i]?.text ?? "").trim() !== "") {
      contentEnd = i + 1;
      break;
    }
  }
  return { headingIndex, end, contentEnd, verbatim };
}
