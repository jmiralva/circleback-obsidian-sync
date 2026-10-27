// Finding and, when the user has opted in, cleaning up more than one file for the same meeting.
//
// Finding is always safe: it only reads the index. Cleaning up trashes a copy only when it
// still looks exactly as the plugin wrote it, so nothing the user added is lost. Anything else,
// such as a meeting the user split into several notes by hand, is left alone and reported.
import type { App, TFile } from "obsidian";
import { PLUGIN_KEYS } from "../format/fields";
import { hashBody } from "../util/hash";
import { logger } from "../util/logger";
import { parseFrontmatter, readFrontmatter, splitFrontmatter } from "./frontmatter";
import type { Kind, MeetingIndex } from "./meetingIndex";

export type DuplicateGroup = {
  id: string;
  kind: Kind;
  /** The file with the earliest `circleback_first_synced` (ties by path), so every device picks the same one. */
  keep: TFile;
  /** The other files for this meeting and kind, in the order `MeetingIndex.find` gives them. Never empty. */
  others: TFile[];
};

/** Every (id, kind) that has more than one file, sorted by id then kind. */
export function findDuplicates(index: MeetingIndex): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  for (const { id, kind } of index.keys()) {
    const [keep, ...others] = index.find(id, kind);
    if (keep && others.length > 0) groups.push({ id, kind, keep, others });
  }
  return groups;
}

function hasOnlyPluginKeys(frontmatter: Record<string, unknown>): boolean {
  return Object.keys(frontmatter).every((key) => PLUGIN_KEYS.includes(key));
}

/**
 * Whether a file is exactly what the plugin wrote: its body still hashes to its
 * `circleback_hash`, and its frontmatter has no key outside the plugin's (`type` included).
 *
 * `fm` is the caller's view of the file, usually from the metadata cache, which can be out of
 * date. The file is read again, and its own frontmatter has to agree, so a field the user added
 * a moment ago cannot slip past. Resolves to false, and logs, when the file cannot be read.
 */
export async function canTrash(app: App, file: TFile, fm: Record<string, unknown>): Promise<boolean> {
  const hash = fm.circleback_hash;
  if (typeof hash !== "string" || !hasOnlyPluginKeys(fm)) return false;

  let text: string;
  try {
    text = await app.vault.read(file);
  } catch (error) {
    logger.warn(`Could not read ${file.path} to check whether it is safe to trash.`, error);
    return false;
  }

  const { yaml, body } = splitFrontmatter(text);
  const current = parseFrontmatter(yaml);
  return (
    current !== null &&
    hasOnlyPluginKeys(current) &&
    current.circleback_hash === hash &&
    hashBody(body) === hash
  );
}

/** Trashes a file if `canTrash` allows it. False means it is still there, for whatever reason. */
async function trashIfUntouched(app: App, file: TFile, index: MeetingIndex | undefined): Promise<boolean> {
  const path = file.path;
  try {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? (await readFrontmatter(app, file));
    if (fm === null || !(await canTrash(app, file, fm))) return false;
    await app.fileManager.trashFile(file);
  } catch (error) {
    logger.error(`Could not clean up the duplicate ${path}; leaving it where it is.`, error);
    return false;
  }
  index?.forget(file);
  logger.info(`Trashed the duplicate ${path}.`);
  return true;
}

/**
 * Trashes every untouched copy (see `canTrash`) and leaves the rest. The keeper is never trashed.
 * Trashing goes through `fileManager.trashFile`, which follows the user's trash setting.
 *
 * - `trashed`: the paths it trashed, as they were before.
 * - `reported`: the paths of every file still in a group with more than one file after the
 *   clean-up, the keeper included. Four hand-split notes give no trashed and four reported.
 *
 * Pass the index to have it `forget` each file as it is trashed. Without it, the caller's
 * index still lists those files until its next `build`.
 */
export async function cleanUpDuplicates(
  app: App,
  groups: DuplicateGroup[],
  index?: MeetingIndex,
): Promise<{ trashed: string[]; reported: string[] }> {
  const trashed: string[] = [];
  const reported: string[] = [];

  for (const group of groups) {
    const remaining: TFile[] = [group.keep];
    for (const file of group.others) {
      const path = file.path;
      if (await trashIfUntouched(app, file, index)) trashed.push(path);
      else remaining.push(file);
    }
    if (remaining.length > 1) reported.push(...remaining.map((file) => file.path));
  }

  return { trashed, reported };
}
