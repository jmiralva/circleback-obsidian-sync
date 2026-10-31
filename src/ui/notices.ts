// The words of the notices. These functions only build text (or decide there is none); the runner
// shows them. The wording matters: a notice is the one place the plugin speaks up on its own, so
// it says what stopped, why, and what to do.
import type { AccountDeviceState } from "../state/deviceState";
import type { AccountErrorKind, RunResult } from "../sync/syncEngine";
import type { SettingsChange } from "./settingsSaver";

// Notices that say the same thing every time.

/** Before a manual sync: the vault is still loading, so the sync waits. */
export const WAITING_FOR_VAULT = "Circleback Sync: waiting for Obsidian to finish loading the vault.";
export const SYNC_OFF_NOTICE =
  'Circleback Sync: syncing is off on this device. Turn on "Sync on this device" in the plugin settings.';
export const NO_KEY_NOTICE = "Circleback Sync: no account has an API key on this device. Add one in the plugin settings.";
export const BUSY_NOTICE = "Circleback Sync: a sync is already running.";
/** The engine threw: a bug or a vault error, not an account failing. */
export const CRASHED_NOTICE =
  'Circleback Sync: the sync failed because of an unexpected error. Use "Copy logs" in the plugin settings for details.';
export const FULL_SYNC_STARTED = "Circleback Sync: full sync started. Progress is in the status bar.";
export const FULL_SYNC_RESUMING = "Circleback Sync: resuming the full sync.";
export const FULL_SYNC_STOPPING = "Circleback Sync: stopping the full sync after the current meeting.";
export const FULL_SYNC_CANCELLED = "Circleback Sync: full sync cancelled.";
export const NO_FULL_SYNC = "Circleback Sync: no full sync is running.";

// Notices from the settings tab.

/** Shown, with a "Run full sync" button, when the settings tab closes after a setting that shapes the text of the notes was changed. */
export const OUTPUT_CHANGE_NOTICE =
  "Circleback Sync: these changes apply to meetings synced from now on. Run a full sync to update the text of existing notes.";
/** Added to the notice above when a folder or file name setting was changed too: a full sync never moves or renames a note. */
export const PLACEMENT_NOTICE_SUFFIX = " Existing notes keep their folders and file names.";
export const OUTPUT_AND_PLACEMENT_CHANGE_NOTICE = OUTPUT_CHANGE_NOTICE + PLACEMENT_NOTICE_SUFFIX;
/** Shown, with no button, when only folder or file name settings were changed: there is nothing for a full sync to do. */
export const PLACEMENT_CHANGE_NOTICE =
  "Circleback Sync: new notes will use the new folders and file names. Existing notes stay where they are.";
/** Added to the full sync notice when a folder dropped out of the sync folders: its notes no longer count. */
export const FOLDER_NOTICE_SUFFIX = " Notes in the old folder stay where they are and are no longer updated.";
export const OUTPUT_AND_FOLDER_CHANGE_NOTICE = OUTPUT_CHANGE_NOTICE + FOLDER_NOTICE_SUFFIX;
/**
 * Shown, with no button and until dismissed, when a folder dropped out of the sync folders and no
 * setting that shapes the text changed.
 */
export const FOLDER_CHANGE_NOTICE =
  "Circleback Sync: meetings will get new notes in the new folder as they sync." + FOLDER_NOTICE_SUFFIX;
export const SETTINGS_NOT_SAVED = "Circleback Sync: could not save the settings.";
export const LOGS_COPIED = "Circleback Sync: logs copied. API keys are removed from them.";
export const LOGS_NOT_COPIED = "Circleback Sync: could not copy the logs.";
export const KEY_NOT_SAVED = "Circleback Sync: could not save the API key.";

/** The notice the settings tab shows when it closes after a change. */
export interface SettingsChangeNotice {
  text: string;
  /** Whether it has a "Run full sync" button. */
  offerFullSync: boolean;
  /** Whether it stays until it is dismissed (or its button is used), instead of going by itself. */
  untilDismissed: boolean;
}

/**
 * What to tell the user when the settings tab closes after `change`. A full sync is offered only
 * when a setting that shapes the text of the notes changed, and that notice stays until it is
 * dismissed or used. When a folder dropped out of the sync folders, the notice says the notes
 * there are no longer updated, and stays until dismissed so that is not missed. Otherwise a change
 * of folders or file names only affects new notes, which keep being updated where they are, and
 * the notice goes by itself.
 */
export function settingsChangeNotice(change: SettingsChange): SettingsChangeNotice {
  if (change.output.length > 0) {
    let text = OUTPUT_CHANGE_NOTICE;
    if (change.syncFolderDropped) text = OUTPUT_AND_FOLDER_CHANGE_NOTICE;
    else if (change.placement.length > 0) text = OUTPUT_AND_PLACEMENT_CHANGE_NOTICE;
    return { text, offerFullSync: true, untilDismissed: true };
  }
  if (change.syncFolderDropped) return { text: FOLDER_CHANGE_NOTICE, offerFullSync: false, untilDismissed: true };
  return { text: PLACEMENT_CHANGE_NOTICE, offerFullSync: false, untilDismissed: false };
}

const REASONS: Record<AccountErrorKind, string> = {
  auth: "the API key was not accepted",
  forbidden: "Circleback refused access",
  "rate-limited": "Circleback's rate limit was reached",
  timeout: "Circleback did not answer in time",
  network: "there was no connection to Circleback",
  server: "Circleback had a server error",
  "invalid-response": "Circleback sent data this plugin version does not understand",
  unexpected: "of an unexpected error",
};

const HINTS: Partial<Record<AccountErrorKind, string>> = {
  auth: " Check its API key in the plugin settings.",
  "invalid-response": " Check for a plugin update.",
  unexpected: ' Use "Copy logs" in the plugin settings for details.',
};

const DEFAULT_HINT = " It will try again at the next sync.";

/** Whether a stored text is one of the error kinds, as state saved by an older or newer version might not be. */
export function isAccountErrorKind(value: string): value is AccountErrorKind {
  // Not `in`: that would also accept names every object has, such as "toString".
  return Object.prototype.hasOwnProperty.call(REASONS, value);
}

/** Why an account stopped syncing, as a clause for "stopped syncing because ...". */
export function reasonText(kind: AccountErrorKind): string {
  return REASONS[kind];
}

/**
 * A notice when an account goes from working to failing, or from failing back to working; null
 * otherwise, so a failing account is not announced on every run. An account that has never run
 * counts as working, so a first run that fails is announced.
 */
export function transitionNotices(
  prev: AccountDeviceState,
  next: { ok: boolean; error?: AccountErrorKind },
  label: string,
): string | null {
  const wasFailing = prev.failing === true;
  if (!wasFailing && !next.ok) {
    const kind = next.error ?? "unexpected";
    return `Circleback Sync: "${label}" stopped syncing because ${reasonText(kind)}.${HINTS[kind] ?? DEFAULT_HINT}`;
  }
  if (wasFailing && next.ok) return `Circleback Sync: "${label}" is syncing again.`;
  return null;
}

/** A notice when the number of meetings with duplicate notes grew since the last run; null otherwise. */
export function duplicateNotice(prevCount: number, nextCount: number): string | null {
  if (nextCount <= prevCount) return null;
  const meetings = nextCount === 1 ? "1 meeting" : `${nextCount} meetings`;
  return `Circleback Sync found ${meetings} with duplicate notes. See the plugin settings.`;
}

/**
 * The notice that closes a run, or null for none. An automatic sync speaks up only when the
 * "show sync notifications" setting is on and something was written or failed. Manual syncs and
 * full syncs always answer, since the user asked for them.
 */
export function resultNotice(
  result: RunResult,
  opts: { manual: boolean; fullSync: boolean; show: boolean },
): string | null {
  let written = 0;
  let failed = 0;
  let stopped = 0;
  for (const account of Object.values(result.perAccount)) {
    written += account.written;
    failed += account.failed;
    if (!account.ok) stopped += 1;
  }
  if (!opts.manual && !opts.fullSync && !(opts.show && (written > 0 || failed > 0))) return null;

  const updated = `${written === 1 ? "1 meeting" : `${written} meetings`} updated.`;
  let text: string;
  if (opts.fullSync) text = `Circleback Sync: full sync finished. ${updated}`;
  else if (written > 0) text = `Circleback Sync: ${updated}`;
  // "Up to date" would hide a failure that the rest of the sentence goes on to name.
  else if (failed > 0 || stopped > 0) text = "Circleback Sync: no meetings updated.";
  else text = "Circleback Sync: everything is up to date.";
  if (failed > 0) text += ` ${failed} could not be written; use "Copy logs" in the plugin settings for details.`;
  if (stopped > 0) text += ` ${stopped === 1 ? "1 account" : `${stopped} accounts`} could not sync; see the status bar.`;
  return text;
}
