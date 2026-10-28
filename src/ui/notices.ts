// The words of the notices. These functions only build text (or decide there is none); the runner
// shows them. The wording matters: a notice is the one place the plugin speaks up on its own, so
// it says what stopped, why, and what to do.
import type { AccountDeviceState } from "../state/deviceState";
import type { AccountErrorKind, RunResult } from "../sync/syncEngine";

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
  let text = opts.fullSync
    ? `Circleback Sync: full sync finished. ${updated}`
    : written > 0
      ? `Circleback Sync: ${updated}`
      : "Circleback Sync: everything is up to date.";
  if (failed > 0) text += ` ${failed} could not be written; use "Copy logs" in the plugin settings for details.`;
  if (stopped > 0) text += ` ${stopped === 1 ? "1 account" : `${stopped} accounts`} could not sync; see the status bar.`;
  return text;
}
