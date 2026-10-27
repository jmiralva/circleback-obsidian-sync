// The plugin's settings, as stored in data.json, and their defaults.
// Where the spec defers to granola-sync's defaults, these follow it, including
// `syncTranscripts: false` and `linkFromDailyNotes: false`.

export interface AccountConfig {
  /** Lowercase UUID. The API key lives in secret storage under `circleback-sync-<id>`. */
  id: string;
  /** Name the user chose, such as "Work". */
  label: string;
  /** "Your name in transcripts". Wins over the name found in the meeting data when not empty. */
  selfNameOverride: string;
}

export type SubfolderPattern = "none" | "day" | "month" | "year-month" | "year-quarter" | "custom";
export type TitleFilterMode = "disabled" | "include" | "exclude";
export type SaveAs = "files" | "sections";
export type BaseFolderType = "custom" | "daily-notes";
export type CreateMissingDailyNotes = "always" | "today" | "never";
export type TranscriptHandling = "custom-location" | "combined" | "same-location";
export type SelfLabel = "you" | "name";

export interface CirclebackSyncSettings {
  // Sync
  accounts: AccountConfig[];
  periodicSync: boolean;
  syncIntervalMinutes: number;
  settleDelayMinutes: number;
  syncNotes: boolean;
  syncTranscripts: boolean;
  showSyncNotifications: boolean;

  // Filtering
  syncDaysBack: number;
  includeShared: boolean;
  titleFilterMode: TitleFilterMode;
  titleFilterKeyword: string;

  // Note content
  includePrivateNotes: boolean;
  includeActionItems: boolean;
  includeInsights: boolean;

  // Note location
  saveAs: SaveAs;
  baseFolderType: BaseFolderType;
  customBaseFolder: string;
  subfolderPattern: SubfolderPattern;
  customSubfolderPattern: string;
  filenamePattern: string;

  // Daily notes
  linkFromDailyNotes: boolean;
  dailyNoteLinkHeading: string;
  dailyNoteSectionHeading: string;
  createMissingDailyNotes: CreateMissingDailyNotes;

  // Transcripts
  transcriptHandling: TranscriptHandling;
  customTranscriptBaseFolder: string;
  transcriptSubfolderPattern: SubfolderPattern;
  customTranscriptSubfolderPattern: string;
  transcriptFilenamePattern: string;
  selfLabel: SelfLabel;

  // Other
  cleanUpDuplicates: boolean;
  debugLogging: boolean;
}

export const DEFAULT_SETTINGS: CirclebackSyncSettings = {
  accounts: [],
  periodicSync: false,
  syncIntervalMinutes: 30,
  settleDelayMinutes: 10,
  syncNotes: true,
  syncTranscripts: false,
  showSyncNotifications: true,

  syncDaysBack: 7,
  includeShared: false,
  titleFilterMode: "disabled",
  titleFilterKeyword: "",

  includePrivateNotes: false,
  includeActionItems: true,
  includeInsights: true,

  saveAs: "files",
  baseFolderType: "custom",
  customBaseFolder: "Circleback",
  subfolderPattern: "none",
  customSubfolderPattern: "",
  filenamePattern: "{title}",

  linkFromDailyNotes: false,
  dailyNoteLinkHeading: "# Meetings",
  dailyNoteSectionHeading: "# Circleback notes",
  createMissingDailyNotes: "always",

  transcriptHandling: "custom-location",
  customTranscriptBaseFolder: "Circleback/Transcripts",
  transcriptSubfolderPattern: "none",
  customTranscriptSubfolderPattern: "",
  transcriptFilenamePattern: "{title}-transcript",
  selfLabel: "you",

  cleanUpDuplicates: false,
  debugLogging: false,
};
