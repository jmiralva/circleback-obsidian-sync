// Which settings change what the plugin writes into notes, and which change where it puts new
// ones, so the settings tab can tell the user what an edit will and will not do to existing notes.
//
// A full sync rewrites the text and frontmatter of existing notes. It never moves or renames
// one (the note writer only renames a note that still sits where the plugin put it under its
// previous title and date, so a changed folder or file name setting leaves every existing note
// where it is). So the two kinds of setting get different advice.
//
// A change can also leave a folder outside the sync folders, the folders whose files count as
// the meetings' files. The notes there are no longer updated, and their meetings get new notes in
// the new folder as they sync, so the user is told that too.
import { isInFolders, syncFolders } from "../settings/syncFolders";
import type { CirclebackSyncSettings } from "../settings/types";

/**
 * Stands in for the daily notes folder, which the settings tab does not read. It is the same on
 * both sides of a comparison, so only a change of setting can count. Obsidian does not allow a
 * colon in a file or folder name, so no real folder is called this.
 */
const DAILY_NOTES_FOLDER = ":daily notes folder:";

/**
 * The settings that decide what a synced note or transcript contains, and whether notes, daily
 * note links and transcripts are written at all. A normal sync only rewrites meetings in the
 * sync window, so after one of these changes the older notes keep their old text until a full
 * sync. The two daily note headings and "create missing daily notes" are left out on purpose.
 */
export const OUTPUT_SETTINGS: (keyof CirclebackSyncSettings)[] = [
  "syncNotes",
  "syncTranscripts",
  "includePrivateNotes",
  "includeActionItems",
  "includeInsights",
  "saveAs",
  "linkFromDailyNotes",
  "transcriptHandling",
  "selfLabel",
];

/**
 * The settings that decide which folder and file name a new note or transcript gets. They affect
 * new files only: no sync, full or not, moves or renames an existing one.
 */
export const PLACEMENT_SETTINGS: (keyof CirclebackSyncSettings)[] = [
  "baseFolderType",
  "customBaseFolder",
  "subfolderPattern",
  "customSubfolderPattern",
  "filenamePattern",
  "customTranscriptBaseFolder",
  "transcriptSubfolderPattern",
  "customTranscriptSubfolderPattern",
  "transcriptFilenamePattern",
];

/** The output settings whose value differs between `prev` and `next`, in the order of OUTPUT_SETTINGS. */
export function changedOutputSettings(prev: CirclebackSyncSettings, next: CirclebackSyncSettings): string[] {
  // Every output setting is a plain string or boolean, so `!==` is a full comparison.
  return OUTPUT_SETTINGS.filter((key) => prev[key] !== next[key]);
}

/** The placement settings whose value differs between `prev` and `next`, in the order of PLACEMENT_SETTINGS. */
export function changedPlacementSettings(prev: CirclebackSyncSettings, next: CirclebackSyncSettings): string[] {
  return PLACEMENT_SETTINGS.filter((key) => prev[key] !== next[key]);
}

/**
 * Whether a folder that was a sync folder under `prev` is outside the sync folders under `next`:
 * its files stay where they are and are no longer updated, and their meetings get new files in
 * the new folders. A sync folder that only grew, or that moved inside another one that stays,
 * leaves every file counted, so it does not count.
 */
export function syncFolderDropped(prev: CirclebackSyncSettings, next: CirclebackSyncSettings): boolean {
  const after = syncFolders(next, DAILY_NOTES_FOLDER);
  return syncFolders(prev, DAILY_NOTES_FOLDER).some((folder) => !isInFolders(folder, after));
}
