// Splitting a note's text into its frontmatter block and its body.
//
// This is the one place that decides where the body starts. The note writer hashes the body it
// writes with it, and duplicate clean-up hashes the body it reads with it, so the two always
// agree on what "the body" is.
import { parseYaml } from "obsidian";
import type { App, TFile } from "obsidian";

export interface SplitText {
  /** The text between the fences, or null when the file has no frontmatter block. */
  yaml: string | null;
  /** Everything after the closing fence line, exactly as stored. The whole text when there is no frontmatter. */
  body: string;
}

const OPENING_FENCE = /^---[ \t]*\r?\n/;
const CLOSING_FENCE = /^---[ \t]*\r?\n?$/;

/**
 * Splits "---\n<yaml>\n---\n<body>". The body starts on the line after the closing fence, and
 * not a byte of it is changed. A block with no closing fence is not frontmatter.
 */
export function splitFrontmatter(text: string): SplitText {
  const opening = OPENING_FENCE.exec(text);
  if (!opening) return { yaml: null, body: text };

  let position = opening[0].length;
  while (position < text.length) {
    const newline = text.indexOf("\n", position);
    const lineEnd = newline === -1 ? text.length : newline + 1;
    if (CLOSING_FENCE.test(text.slice(position, lineEnd))) {
      return { yaml: text.slice(opening[0].length, position), body: text.slice(lineEnd) };
    }
    position = lineEnd;
  }
  return { yaml: null, body: text };
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The frontmatter as an object, or null when there is none, it is empty, it is broken, or it is not a mapping. */
export function parseFrontmatter(yaml: string | null): Record<string, unknown> | null {
  if (yaml === null) return null;
  try {
    const parsed: unknown = parseYaml(yaml);
    return isMapping(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reads a file and parses its frontmatter itself, without the metadata cache. For files the
 * cache has not indexed yet. Rejects when the file cannot be read.
 */
export async function readFrontmatter(app: App, file: TFile): Promise<Record<string, unknown> | null> {
  return parseFrontmatter(splitFrontmatter(await app.vault.read(file)).yaml);
}
