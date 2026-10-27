// Which vault files hold which meeting, so a file that was moved or renamed is updated where
// it is and never written a second time.
//
// A file is indexed when its frontmatter has a string `circleback_id` and a `circleback_kind`
// that is one of the three kinds. The index is keyed by (id, kind): a meeting's note and its
// transcript share an id but are separate files. It holds the file objects themselves, not
// their paths, so a rename does not lose a file.
//
// Obsidian's metadata cache lags behind writes, and is empty at startup. Two things cover for it:
// `build` reads and parses any file in the configured folders that the cache has no entry for,
// and `upsert` / `forget` let the code that writes or trashes a file during a run tell the index
// at once.
import { normalizePath } from "obsidian";
import type { App, TFile } from "obsidian";
import { isFileKind, type FileKind } from "../format/fields";
import { logger } from "../util/logger";
import { readFrontmatter } from "./frontmatter";

export type Kind = FileKind;

export interface MeetingKey {
  id: string;
  kind: Kind;
}

interface Entry {
  frontmatter: Record<string, unknown>;
  group: Group;
}

interface Group extends MeetingKey {
  files: Set<TFile>;
}

function compareText(a: string, b: string): number {
  // By UTF-16 code unit, not by locale, so every device sorts the same way.
  return a < b ? -1 : a > b ? 1 : 0;
}

function groupKey(id: string, kind: Kind): string {
  // `kind` never contains a colon, so the pair cannot collide.
  return `${kind}:${id}`;
}

function meetingKeyOf(frontmatter: Record<string, unknown>): MeetingKey | null {
  const { circleback_id: id, circleback_kind: kind } = frontmatter;
  return typeof id === "string" && id !== "" && isFileKind(kind) ? { id, kind } : null;
}

function firstSynced(frontmatter: Record<string, unknown>): string | null {
  const value = frontmatter.circleback_first_synced;
  return typeof value === "string" && value !== "" ? value : null;
}

/** The normalized folders; the vault root, whatever it was spelled as, is "/". */
function insideFolders(path: string, folders: readonly string[]): boolean {
  return folders.some((folder) => folder === "/" || path.startsWith(`${folder}/`));
}

export class MeetingIndex {
  private readonly entries = new Map<TFile, Entry>();
  private readonly groups = new Map<string, Group>();

  /**
   * @param folders The folders the plugin writes into, read on every `build`. "" (or "/") is the
   * whole vault. Files outside them are indexed too if the metadata cache knows their
   * frontmatter, so a note moved out of these folders is still found.
   */
  constructor(
    private readonly app: App,
    private readonly folders: () => string[],
  ) {}

  /**
   * Scans every Markdown file and replaces what the index held. A file in the configured
   * folders that the metadata cache has no entry for is read and parsed directly (the cache
   * may simply not have reached it yet), and one outside them is skipped. A file that cannot be
   * read is skipped and logged.
   */
  async build(): Promise<void> {
    const folders = this.folders().map((folder) => normalizePath(folder));
    const found: Array<[TFile, Record<string, unknown>]> = [];

    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      let frontmatter: Record<string, unknown> | null;
      if (cache) {
        frontmatter = cache.frontmatter ?? null;
      } else if (insideFolders(file.path, folders)) {
        try {
          frontmatter = await readFrontmatter(this.app, file);
        } catch (error) {
          logger.warn(`Could not read ${file.path} to look for a Circleback meeting; skipping it.`, error);
          continue;
        }
      } else {
        continue;
      }
      if (frontmatter !== null) found.push([file, frontmatter]);
    }

    // Swap in the result only now, so the index is never half built.
    this.entries.clear();
    this.groups.clear();
    for (const [file, frontmatter] of found) this.upsert(file, frontmatter);
  }

  /**
   * Every file for this meeting and kind, oldest `circleback_first_synced` first. A file with
   * no first_synced comes after those that have one. Ties are broken by path.
   */
  find(id: string, kind: Kind): TFile[] {
    const group = this.groups.get(groupKey(id, kind));
    if (!group) return [];
    const stamped = [...group.files].map((file) => ({
      file,
      synced: firstSynced(this.entries.get(file)?.frontmatter ?? {}),
    }));
    stamped.sort((a, b) => {
      if (a.synced !== b.synced) {
        if (a.synced === null) return 1;
        if (b.synced === null) return -1;
        return compareText(a.synced, b.synced);
      }
      return compareText(a.file.path, b.file.path);
    });
    return stamped.map(({ file }) => file);
  }

  /**
   * The frontmatter the index holds for a file: as of the last `build` or `upsert`, not the
   * live cache. Null for a file that is not indexed.
   */
  frontmatter(file: TFile): Record<string, unknown> | null {
    return this.entries.get(file)?.frontmatter ?? null;
  }

  /** Every (id, kind) the index holds, sorted by id then kind. */
  keys(): MeetingKey[] {
    return [...this.groups.values()]
      .map(({ id, kind }) => ({ id, kind }))
      .sort((a, b) => compareText(a.id, b.id) || compareText(a.kind, b.kind));
  }

  /**
   * Records a file's frontmatter, replacing what the index knew about it. Call it after writing
   * a file during a run, so the file is found before the metadata cache has caught up. Frontmatter
   * that is not a plugin file's (or null) removes the file from the index.
   */
  upsert(file: TFile, frontmatter: Record<string, unknown> | null): void {
    this.forget(file);
    if (frontmatter === null) return;
    const key = meetingKeyOf(frontmatter);
    if (key === null) return;

    const lookup = groupKey(key.id, key.kind);
    let group = this.groups.get(lookup);
    if (!group) {
      group = { ...key, files: new Set() };
      this.groups.set(lookup, group);
    }
    group.files.add(file);
    // A copy, so nothing that holds the metadata cache's own object can change what we know.
    this.entries.set(file, { frontmatter: { ...frontmatter }, group });
  }

  /** Removes a file from the index. Call it after trashing a file during a run. */
  forget(file: TFile): void {
    const entry = this.entries.get(file);
    if (!entry) return;
    this.entries.delete(file);
    entry.group.files.delete(file);
    if (entry.group.files.size === 0) this.groups.delete(groupKey(entry.group.id, entry.group.kind));
  }
}
