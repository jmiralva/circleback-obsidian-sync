// What the settings tab says and which of its settings it shows, decided here as pure functions
// because settingsTab.ts needs a DOM and cannot be unit-tested.
import { moment } from "obsidian";
import { CirclebackError } from "../api/errors";
import type { ConnectionInfo } from "../api/schemas";
import type { CirclebackSyncSettings } from "../settings/types";
import type { AccountDeviceState } from "../state/deviceState";
import type { AccountErrorKind } from "../sync/syncEngine";
import { logger } from "../util/logger";
import type { Kind } from "../vault/meetingIndex";
import { isAccountErrorKind, reasonText } from "./notices";

/** An error kind from stored state, or "unexpected" when it is missing or not one this version knows. */
function errorKind(stored: string | undefined): AccountErrorKind {
  return stored !== undefined && isAccountErrorKind(stored) ? stored : "unexpected";
}

/**
 * The line under an account's API key: that the key is missing on this device, why the account
 * stopped syncing, when it last synced, or that it has not synced yet.
 */
export function accountStatusLine(hasKey: boolean, state: AccountDeviceState): string {
  if (!hasKey) return "Key needed on this device";
  if (state.failing === true) return `Stopped syncing because ${reasonText(errorKind(state.lastError))}`;
  if (state.lastSuccessAt !== undefined) {
    // Local time, as everything the user sees is.
    const last = moment.utc(new Date(state.lastSuccessAt)).local();
    if (last.isValid()) return `Last synced ${last.format("MMM D, HH:mm")}`;
  }
  return "Not synced yet";
}

export const NO_KEY_TO_TEST = "Enter an API key first.";
/** The key field with no key stored on this device. */
export const KEY_PLACEHOLDER = "Paste your Circleback API key";
/** Twelve bullet dots (U+2022). The key is never in the field; this makes the field look filled. */
export const KEY_STORED_PLACEHOLDER = "\u2022".repeat(12);
/** The key field after "Replace key", while it waits for the new key. */
export const KEY_REPLACING_PLACEHOLDER = "Paste the new API key";
/** The field's accessible name, so that "a key is stored" is not only visual. */
export const KEY_LABEL = "API key";
export const KEY_STORED_LABEL = "API key stored on this device. Use Replace key to change it.";
export const KEY_REPLACING_LABEL = "New API key";
/** The button that opens a locked key field for a new key. */
export const REPLACE_KEY_BUTTON = "Replace key";

/** What the account's API key row shows: the status line, the field's look, state and name, and which buttons it offers. */
export interface KeyRowView {
  status: string;
  placeholder: string;
  /**
   * Whether the field is locked: this device has the key and the user has not asked to replace it.
   * A locked field shows its placeholder (dots) in the normal text color, so one output serves both.
   */
  disabled: boolean;
  ariaLabel: string;
  // Each button has its own output so that its rule can change without the other's. Today both
  // follow whether this device has a key, and both stay while a new key is being entered.
  canReplace: boolean;
  canClear: boolean;
}

/**
 * The key row for an account, by whether this device has its key and whether the user opened the
 * field to replace it. Without a key there is nothing to replace, so `replacing` is then ignored.
 * The key itself is never shown.
 */
export function keyRowView(hasKey: boolean, state: AccountDeviceState, replacing: boolean): KeyRowView {
  const status = accountStatusLine(hasKey, state);
  if (!hasKey) {
    return { status, placeholder: KEY_PLACEHOLDER, disabled: false, ariaLabel: KEY_LABEL, canReplace: false, canClear: false };
  }
  if (replacing) {
    return {
      status,
      placeholder: KEY_REPLACING_PLACEHOLDER,
      disabled: false,
      ariaLabel: KEY_REPLACING_LABEL,
      canReplace: true,
      canClear: true,
    };
  }
  return {
    status,
    placeholder: KEY_STORED_PLACEHOLDER,
    disabled: true,
    ariaLabel: KEY_STORED_LABEL,
    canReplace: true,
    canClear: true,
  };
}

/**
 * Whether two key rows show the same, so that the row is only rewritten when it would change.
 * Rewriting it on every status update, which includes each progress tick of a full sync, would
 * drop a text selection in the status line. Entering or leaving "replacing" changes the
 * placeholder, the name and `disabled`, so this sees it.
 */
export function sameKeyRowView(a: KeyRowView, b: KeyRowView): boolean {
  return (
    a.status === b.status &&
    a.placeholder === b.placeholder &&
    a.disabled === b.disabled &&
    a.ariaLabel === b.ariaLabel &&
    a.canReplace === b.canReplace &&
    a.canClear === b.canClear
  );
}

/** The account list is in data.json, so removing an account removes it everywhere the vault is shared. */
export const REMOVE_ACCOUNT_TEXT =
  "Removes the account on every device that shares this vault, and its API key from this device. Its notes stay in the vault.";

/** The title of an account's block in the settings tab when its label is empty. */
export const UNNAMED_ACCOUNT = "Unnamed account";

/** The title of an account's block: its label, or a stand-in when the label is empty. */
export function accountTitle(label: string): string {
  const trimmed = label.trim();
  return trimmed === "" ? UNNAMED_ACCOUNT : trimmed;
}

export function removeAccountTitle(label: string): string {
  return `Remove "${label}"?`;
}

/** The label of the full sync button: cancelling a running sync, or starting one. */
export function fullSyncButtonText(running: boolean): string {
  return running ? "Cancel full sync" : "Start full sync";
}

export interface ConnectionOutcome {
  /** What to show under the account. */
  text: string;
  /** The key owner's email, when the test got that far, for the tab to cache. */
  email?: string;
}

/**
 * Tests an account's API key. Never throws: a failure becomes the text to show.
 * `key` is null when this device has none stored.
 */
export async function checkConnection(
  key: string | null,
  clientFor: (key: string) => { testConnection(): Promise<ConnectionInfo> },
): Promise<ConnectionOutcome> {
  if (key === null) return { text: NO_KEY_TO_TEST };
  try {
    const { email, apiKeyName } = await clientFor(key).testConnection();
    const keyName = apiKeyName === undefined || apiKeyName === "" ? "" : ` with key "${apiKeyName}"`;
    return { text: `Connected as ${email}${keyName}`, email };
  } catch (error) {
    // The user sees only the reason; the detail goes to the log, which redacts API keys.
    logger.warn("Test connection failed.", error);
    const kind: AccountErrorKind = error instanceof CirclebackError ? error.kind : "unexpected";
    return { text: `Could not connect because ${reasonText(kind)}.` };
  }
}

export const NO_DUPLICATES = "No duplicates found in the last sync on this device.";
export const DUPLICATES_INTRO =
  "Meetings that still had more than one file after the last sync on this device. The first file in each group is the one that is kept.";

const DUPLICATE_KINDS: Record<Kind, string> = {
  note: "Note",
  transcript: "Transcript",
  combined: "Note with transcript",
};

/** A file of a duplicate group, by the path it has now. */
export interface DuplicateFileView {
  path: string;
  /** The first file of a group is the one that is kept. */
  kept: boolean;
}

export interface DuplicateGroupView {
  kind: string;
  files: DuplicateFileView[];
}

/** What the Duplicates section shows under its toggle: a sentence, then a list when there is anything to list. */
export interface DuplicatesView {
  message: string;
  groups: DuplicateGroupView[];
}

/** The duplicates from the last sync as the section shows them. Files are read by path only. */
export function duplicatesView(
  groups: ReadonlyArray<{ kind: Kind; keep: { path: string }; others: ReadonlyArray<{ path: string }> }>,
): DuplicatesView {
  if (groups.length === 0) return { message: NO_DUPLICATES, groups: [] };
  return {
    message: DUPLICATES_INTRO,
    groups: groups.map((group) => ({
      kind: DUPLICATE_KINDS[group.kind],
      files: [
        { path: group.keep.path, kept: true },
        ...group.others.map((other) => ({ path: other.path, kept: false })),
      ],
    })),
  };
}

/**
 * Whether two views show the same, so that the section is only rebuilt when it would change.
 * Rebuilding it on every status update would replace a link while it is being clicked.
 */
export function sameDuplicatesView(a: DuplicatesView, b: DuplicatesView): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Which settings the tab shows, by the choices made in the settings above them. */
export interface SettingsVisibility {
  /** The title filter's keyword: only while a title filter is on. */
  titleKeyword: boolean;
  /** The whole Transcripts group: only while transcripts are synced. */
  transcripts: boolean;
  /** Folder, subfolder, filename and daily-note link settings: only when notes are individual files. */
  fileSettings: boolean;
  customBaseFolder: boolean;
  customSubfolder: boolean;
  /** The heading that daily-note links go under. */
  linkHeading: boolean;
  /** The heading that daily-note sections go under: only when notes are sections. */
  sectionHeading: boolean;
  /** Whether the plugin writes into daily notes at all, so whether it may create missing ones. */
  createMissingDailyNotes: boolean;
  /** The transcript folder and subfolder settings: only for transcripts in a custom location. */
  transcriptFolder: boolean;
  transcriptCustomSubfolder: boolean;
  /** Every handling except combined gives the transcript a file name. */
  transcriptFilename: boolean;
}

export function settingsVisibility(settings: CirclebackSyncSettings): SettingsVisibility {
  const files = settings.saveAs === "files";
  const sections = settings.saveAs === "sections";
  const transcripts = settings.syncTranscripts;
  const customLocation = transcripts && settings.transcriptHandling === "custom-location";
  return {
    titleKeyword: settings.titleFilterMode !== "disabled",
    transcripts,
    fileSettings: files,
    customBaseFolder: files && settings.baseFolderType === "custom",
    customSubfolder: files && settings.subfolderPattern === "custom",
    linkHeading: files && settings.linkFromDailyNotes,
    sectionHeading: sections,
    createMissingDailyNotes: sections || (files && settings.linkFromDailyNotes),
    transcriptFolder: customLocation,
    transcriptCustomSubfolder: customLocation && settings.transcriptSubfolderPattern === "custom",
    transcriptFilename: transcripts && settings.transcriptHandling !== "combined",
  };
}

/** What a full sync does, as the description of its button. It says more when it would also create daily notes. */
export function fullSyncDescription(settings: CirclebackSyncSettings): string {
  const base =
    "Rewrites every synced note from your whole Circleback history, not only the sync window. Edits to the text of a synced note are replaced; frontmatter fields the plugin does not own are kept.";
  const createsDailyNotes = settingsVisibility(settings).createMissingDailyNotes && settings.createMissingDailyNotes === "always";
  return createsDailyNotes ? `${base} It can also create a daily note for every past meeting day that lacks one.` : base;
}
