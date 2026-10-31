// The sync folders: the folders the plugin writes meetings into, each with every folder under it.
//
// Only a file inside them counts as a meeting's file. A file the user moved out of them is the
// user's from then on: it is never updated, renamed, reported as a duplicate or trashed, and the
// meeting gets a fresh file inside them at the next sync that covers it. The sync engine uses
// these folders to build its index, and the settings tab to tell whether a change leaves files behind.
import type { CirclebackSyncSettings } from "./types";

/**
 * The sync folders for these settings, as the settings spell them: where notes go (the custom
 * base folder, or the daily notes folder), where transcripts go when they have a folder of their
 * own, and the daily notes folder in sections mode. "" (or "/") is the whole vault.
 */
export function syncFolders(settings: CirclebackSyncSettings, dailyFolder: string): string[] {
  const folders = [settings.baseFolderType === "custom" ? settings.customBaseFolder : dailyFolder];
  if (settings.transcriptHandling === "custom-location") folders.push(settings.customTranscriptBaseFolder);
  if (settings.saveAs === "sections") folders.push(dailyFolder);
  return folders;
}

/**
 * Whether a vault path (a file or a folder) is one of `folders` or inside one, at any depth.
 * The folders must be normalized (`normalizePath`), so the vault root is "/".
 */
export function isInFolders(path: string, folders: readonly string[]): boolean {
  return folders.some((folder) => folder === "/" || path === folder || path.startsWith(`${folder}/`));
}
