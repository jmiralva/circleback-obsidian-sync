// Which files in the sync folders hold which meeting, so a file that was moved or renamed inside
// them is updated where it is and never written a second time.
//
// Only files inside the sync folders (see `settings/syncFolders`) are indexed. A file moved out
// of them is not, even though the metadata cache still knows its frontmatter: it is the user's
// now, so the plugin never writes, renames, reports or trashes it, and the meeting gets a fresh
// file in the sync folders. A file moved out after `build` (during a long full sync, say) is
// no longer handed out by `find` or counted by `keys`.
//
// A file is indexed when its frontmatter has a string `circleback_id` and a `circleback_kind`
// that is one of the three kinds. The index is keyed by (id, kind): a meeting's note and its
// transcript share an id but are separate files. It holds the file objects themselves, not
// their paths, so a rename does not lose a file.
//
// Obsidian's metadata cache lags behind writes, and is empty at startup. Two things cover for it:
// `build` reads and parses any file in the sync folders that the cache has no entry for, and
// `upsert` / `forget` let the code that writes or trashes a file during a run tell the index at once.
import type { App, TFile } from "obsidian";
import { isFileKind, type FileKind } from "../format/fields";
import { isInFolders } from "../settings/syncFolders";
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

export class MeetingIndex {
  private readonly entries = new Map<TFile, Entry>();
  private readonly groups = new Map<string, Group>();

  /**
   * @param folders The sync folders, read whenever the index looks at a file's path. "" (or "/")
   * is the whole vault. A file outside them is never indexed, even when the metadata cache knows
   * its frontmatter, and never handed out.
   */
  constructor(
    private readonly app: App,
    private readonly folders: () => string[],
  ) {}

  /**
   * Scans every Markdown file in the sync folders and replaces what the index held. A file that
   * the metadata cache has no entry for is read and parsed directly (the cache may simply not
   * have reached it yet). A file that cannot be read is skipped and logged.
   */
  async build(): Promise<void> {
    const folders = this.folders();
    const found: Array<[TFile, Record<string, unknown>]> = [];

    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!isInFolders(file.path, folders)) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      let frontmatter: Record<string, unknown> | null;
      if (cache) {
        frontmatter = cache.frontmatter ?? null;
      } else {
        try {
          frontmatter = await readFrontmatter(this.app, file);
        } catch (error) {
          logger.warn(`Could not read ${file.path} to look for a Circleback meeting; skipping it.`, error);
          continue;
        }
      }
      if (frontmatter !== null) found.push([file, frontmatter]);
    }

    // Swap in the result only now, so the index is never half built.
    this.entries.clear();
    this.groups.clear();
    for (const [file, frontmatter] of found) this.upsert(file, frontmatter);
  }

  /**
   * Every file for this meeting and kind that is still in the sync folders, oldest
   * `circleback_first_synced` first. A file with no first_synced comes after those that have one.
   * On a tie (both missing included), the shorter path comes first, then the lower path by code
   * unit. A hand copy (`X copy.md` from Finder, `X 1.md` from Obsidian) keeps the original's
   * first_synced, so its longer path sorts it after `X.md`. Every device sorts the same way.
   */
  find(id: string, kind: Kind): TFile[] {
    const group = this.groups.get(groupKey(id, kind));
    if (!group) return [];
    const stamped = this.inSyncFolders(group.files).map((file) => ({
      file,
      synced: firstSynced(this.entries.get(file)?.frontmatter ?? {}),
    }));
    stamped.sort((a, b) => {
      if (a.synced !== b.synced) {
        if (a.synced === null) return 1;
        if (b.synced === null) return -1;
        return compareText(a.synced, b.synced);
      }
      return a.file.path.length - b.file.path.length || compareText(a.file.path, b.file.path);
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

  /** Every (id, kind) the index holds a file in the sync folders for, sorted by id then kind. */
  keys(): MeetingKey[] {
    return [...this.groups.values()]
      .filter((group) => this.inSyncFolders(group.files).length > 0)
      .map(({ id, kind }) => ({ id, kind }))
      .sort((a, b) => compareText(a.id, b.id) || compareText(a.kind, b.kind));
  }

  /**
   * Records a file's frontmatter, replacing what the index knew about it. Call it after writing
   * a file during a run, so the file is found before the metadata cache has caught up. Frontmatter
   * that is not a plugin file's (or null), or a file outside the sync folders, removes the file
   * from the index.
   */
  upsert(file: TFile, frontmatter: Record<string, unknown> | null): void {
    this.forget(file);
    if (frontmatter === null || !isInFolders(file.path, this.folders())) return;
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

  /** The files that are, where they are now, still in the sync folders: the user may have moved one out since. */
  private inSyncFolders(files: Iterable<TFile>): TFile[] {
    const folders = this.folders();
    return [...files].filter((file) => isInFolders(file.path, folders));
  }
}
