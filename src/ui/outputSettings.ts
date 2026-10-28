// Which settings change what the plugin writes into notes, so the settings tab can tell the user
// that existing notes keep their old form until a full sync rewrites them.
import type { CirclebackSyncSettings } from "../settings/types";

/**
 * The settings that decide what a synced note or transcript contains or where it goes. A normal
 * sync only rewrites meetings in the sync window, so after one of these changes the older notes
 * stay as they were until a full sync.
 */
export const OUTPUT_SETTINGS: (keyof CirclebackSyncSettings)[] = [
  "syncTranscripts",
  "includePrivateNotes",
  "includeActionItems",
  "includeInsights",
  "saveAs",
  "baseFolderType",
  "customBaseFolder",
  "subfolderPattern",
  "customSubfolderPattern",
  "filenamePattern",
  "transcriptHandling",
  "customTranscriptBaseFolder",
  "transcriptSubfolderPattern",
  "customTranscriptSubfolderPattern",
  "transcriptFilenamePattern",
  "selfLabel",
];

/** The output settings whose value differs between `prev` and `next`, in the order of OUTPUT_SETTINGS. */
export function changedOutputSettings(prev: CirclebackSyncSettings, next: CirclebackSyncSettings): string[] {
  // Every output setting is a plain string or boolean, so `!==` is a full comparison.
  return OUTPUT_SETTINGS.filter((key) => prev[key] !== next[key]);
}
