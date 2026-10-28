// The sync engine: brings every connected account's Circleback meetings into the vault.
//
// Every run, normal or full, holds the device's one sync lock and goes through four steps:
// 1. Set up. The meeting index is built once, before anything writes (a build swaps its result
//    in at the end, so a write during it would be forgotten). Then one note writer, one
//    daily-notes helper, and one Circleback client per account, for this run only.
// 2. Fetch. Each account on its own: an account that fails in any way (a bad key, the network,
//    a page that fails validation) records its error and writes nothing this run, and the
//    others carry on.
// 3. Write, one meeting at a time. Each meeting id once, by the account that owns it when that
//    account is connected. A meeting the vault already has is neither fetched again nor
//    rewritten, but its daily-note line or block is checked every run, so a failed one heals.
// 4. Afterwards. Duplicates are reported (and cleaned up, when the user opted in), and each
//    account's outcome goes into device state. Nothing here writes data.json.
//
// A full sync is the same with no window and every note rewritten, one page at a time. Its
// place is saved in device state after each page, so it resumes after Obsidian restarts.
import { moment } from "obsidian";
import type { App, TFile } from "obsidian";
import type { CirclebackClient, MeetingsPage } from "../api/circlebackClient";
import { CirclebackError, type CirclebackErrorKind } from "../api/errors";
import type { Meeting, TranscriptSegment } from "../api/schemas";
import { meetingTitle } from "../format/fields";
import { buildNoteBody } from "../format/noteBody";
import { findOwner, ownsMeeting } from "../format/owner";
import type { KeyStore } from "../secrets/keyStore";
import type { AccountConfig, CirclebackSyncSettings } from "../settings/types";
import type { AccountDeviceState, DeviceState } from "../state/deviceState";
import { logger } from "../util/logger";
import type { Moment } from "../util/time";
import { DailyNotes, readDailyNoteConfig } from "../vault/dailyNotes";
import { cleanUpDuplicates, findDuplicates, type DuplicateGroup } from "../vault/duplicates";
import { MeetingIndex } from "../vault/meetingIndex";
import { NoteWriter, type WriteContext, type WriteResult } from "../vault/noteWriter";
import { SyncLock } from "./lock";
import { assignWriters, keepMeeting, pageIsPastWindow, windowStart, type FetchedAccount } from "./select";

/** The part of `CirclebackClient` the engine uses, so tests can stand in for it. */
export type SyncClient = Pick<CirclebackClient, "testConnection" | "listMeetingsPage" | "getTranscript" | "rateLimit">;

/**
 * Why an account failed this run: the kind of Circleback error, or `unexpected` for anything
 * else (a bug), which the log has in full.
 */
export type AccountErrorKind = CirclebackErrorKind | "unexpected";

/**
 * How a full sync is told to stop early. `cancelled` is the user's choice: the sync forgets where
 * it was. `stopped` is for Obsidian closing: it stops at the same places, but keeps where it was,
 * as if the app had quit, so the next full sync resumes. `cancelled` wins when both are set.
 */
export type FullSyncSignal = { cancelled: boolean; stopped?: boolean };

export type AccountResult = {
  /** False when the account failed this run; `error` says why. */
  ok: boolean;
  /** Meetings whose note, transcript or daily-note block changed. */
  written: number;
  /** Meetings the vault already had as they are. */
  skipped: number;
  /**
   * Meetings that could not be written this run, such as a vault error or a transcript that
   * would not load. The next run tries them again. They do not fail the account.
   */
  failed: number;
  error?: AccountErrorKind;
};

export type RunResult = {
  /** By account id: each account this run synced. One with no key on this device is not here. */
  perAccount: Record<string, AccountResult>;
  /** Meetings that still have more than one file, after any clean-up. */
  duplicates: DuplicateGroup[];
};

export interface SyncEngineDeps {
  app: App;
  /** Read once at the start of each run, so a settings edit mid-run cannot mix two layouts. */
  settings: () => CirclebackSyncSettings;
  keys: KeyStore;
  device: DeviceState;
  clientFor: (key: string) => SyncClient;
  now: () => Date;
}

/**
 * Transcript errors after which the account cannot go on this run; any other skips one meeting.
 * `invalid-response` is one: a transcript that fails validation means Circleback changed its API,
 * which every later transcript would hit too, and the account must show as failing.
 */
const STOPS_ACCOUNT: readonly CirclebackErrorKind[] = ["auth", "rate-limited", "invalid-response"];

const NOTHING: RunResult = { perAccount: {}, duplicates: [] };

/** What one run shares. */
interface Run {
  settings: CirclebackSyncSettings;
  /** `settings` as the note writer gets them (see `writerSettingsFor`). */
  writerSettings: CirclebackSyncSettings;
  index: MeetingIndex;
  writer: NoteWriter;
  dailyNotes: DailyNotes;
  dailyFolder: string;
  /** Rewrite every note, current or not: a full sync. */
  force: boolean;
  now: Date;
  /** `now` in local time, for daily notes. */
  nowLocal: Moment;
}

/** One account during a run. */
interface AccountRun {
  config: AccountConfig;
  client: SyncClient;
  /** The email of the key's person, cached in device state. "" until known. */
  ownerEmail: string;
  /** The key's person's name as found in meetings, cached in device state. */
  ownerName: string | null;
  result: AccountResult;
}

export class SyncEngine {
  /** Shared by normal and full syncs: one at a time on this device. */
  readonly lock = new SyncLock();

  constructor(private readonly deps: SyncEngineDeps) {}

  /** Syncs the meetings inside the sync window. `"busy"` when another sync is running. */
  sync(): Promise<RunResult | "busy"> {
    return this.lock.run(() => this.runSync());
  }

  /**
   * Rewrites every meeting of every account, the whole history, page by page. `onProgress` gets
   * the number of meetings done so far after each one. Setting `signal.cancelled` stops it at the
   * next meeting and forgets where it was; setting `signal.stopped` stops it there too but keeps
   * where it was, as if Obsidian had closed, so the next full sync resumes.
   * `"busy"` when another sync is running.
   */
  fullSync(onProgress: (done: number) => void, signal: FullSyncSignal): Promise<RunResult | "busy"> {
    return this.lock.run(() => this.runFullSync(onProgress, signal));
  }

  private async runSync(): Promise<RunResult> {
    const settings = this.deps.settings();
    const accounts = this.eligibleAccounts(settings);
    if (accounts.length === 0) return NOTHING;
    const run = await this.openRun(settings, false);
    const start = windowStart(run.now, settings.syncDaysBack);

    // Side by side, so one account's slow answers do not hold up another's requests.
    const fetched = await Promise.all(accounts.map((acc) => this.fetchWindow(run, acc, start)));
    const writers = assignWriters(fetched.filter((account): account is FetchedAccount => account !== null));
    const byId = new Map(accounts.map((acc) => [acc.config.id, acc]));
    for (const { meeting, accountId } of writers.values()) {
      const acc = byId.get(accountId);
      if (acc?.result.ok) await this.processMeeting(run, acc, meeting);
    }
    return this.finish(run, accounts);
  }

  /**
   * An account's meetings inside the window, page by page until a page is past the window or
   * there is no next page. Null when anything failed: the error is recorded on the account and
   * none of its pages are used.
   */
  private async fetchWindow(run: Run, acc: AccountRun, start: Date): Promise<FetchedAccount | null> {
    try {
      await this.setUp(acc);
      const meetings: Meeting[] = [];
      const followed = new Set<string>();
      let cursorUrl: string | undefined;
      for (;;) {
        const page = await acc.client.listMeetingsPage({ ownership: ownershipFor(run.settings), cursorUrl });
        this.learnOwnerName(acc, page.meetings);
        meetings.push(...page.meetings.filter((m) => keepMeeting(m, run.settings, start)));
        if (page.nextUrl === null || pageIsPastWindow(page.meetings, start)) break;
        cursorUrl = followOnce(followed, page.nextUrl);
      }
      return { accountId: acc.config.id, ownerEmail: acc.ownerEmail, meetings };
    } catch (error) {
      this.fail(acc, error);
      return null;
    }
  }

  private async runFullSync(onProgress: (done: number) => void, signal: FullSyncSignal): Promise<RunResult> {
    const settings = this.deps.settings();
    const eligible = this.eligibleAccounts(settings);
    if (eligible.length === 0) return NOTHING;
    const run = await this.openRun(settings, true);
    const { device } = this.deps;

    // A full sync that Obsidian closed on picks up where it was: only the accounts it had not
    // finished, each from the page it had reached. Otherwise every account starts from the top.
    const unfinished = eligible.filter((acc) => device.account(acc.config.id).fullSyncActive === true);
    const accounts = unfinished.length > 0 ? unfinished : eligible;
    if (unfinished.length === 0) {
      for (const acc of accounts) device.update(acc.config.id, { fullSyncActive: true, fullSyncCursor: null });
    }

    // Every email first, so that no account writes a meeting that another connected account owns.
    await Promise.all(
      accounts.map(async (acc) => {
        try {
          await this.setUp(acc);
        } catch (error) {
          this.fail(acc, error);
          this.endFullSync(acc);
        }
      }),
    );

    const seen = new Set<string>();
    const ran = new Set<AccountRun>();
    let done = 0;
    let halt: "cancelled" | "stopped" | null = null;
    for (const acc of accounts) {
      if (!acc.result.ok) continue;
      // Checked before the account counts as having run, so one that was never reached is not
      // credited with a successful sync in `finish`.
      halt = halted(signal);
      if (halt !== null) break;
      ran.add(acc);
      // Every other connected account whose email is known, even one that failed this run: a
      // forced rewrite by another account would replace the owner's copy (its private notes, its
      // "You") and its label, and the owner would not take the note back until the meeting changed.
      const owners = eligible
        .filter((other) => other !== acc && other.ownerEmail !== "")
        .map((other) => other.ownerEmail);
      const outcome = await this.fullSyncAccount(run, acc, owners, seen, signal, () => onProgress(++done));
      if (outcome === "cancelled" || outcome === "stopped") {
        halt = outcome;
        break;
      }
    }
    // The user chose to stop, so the next full sync starts over. When Obsidian is closing instead
    // (`stopped`), every account keeps its mark and cursor, so the next full sync resumes.
    if (halt === "cancelled") for (const acc of accounts) this.endFullSync(acc);
    return this.finish(
      run,
      accounts.filter((acc) => ran.has(acc) || !acc.result.ok),
    );
  }

  /**
   * One account's part of a full sync. After each page the next page's link is saved, so a
   * restart resumes there. A failure ends this account's full sync (the next one starts it
   * over) without stopping the other accounts.
   *
   * @param owners The emails of the other connected accounts: a meeting one of them owns is theirs to write.
   * @param seen Meeting ids already handled in this full sync, by any account.
   */
  private async fullSyncAccount(
    run: Run,
    acc: AccountRun,
    owners: string[],
    seen: Set<string>,
    signal: FullSyncSignal,
    progress: () => void,
  ): Promise<"done" | "cancelled" | "stopped" | "failed"> {
    const { device } = this.deps;
    const followed = new Set<string>();
    let cursorUrl = device.account(acc.config.id).fullSyncCursor ?? undefined;
    for (;;) {
      const pageHalt = halted(signal);
      if (pageHalt !== null) return pageHalt;
      let page: MeetingsPage;
      let next: string | null;
      try {
        page = await acc.client.listMeetingsPage({ ownership: ownershipFor(run.settings), cursorUrl });
        next = page.nextUrl === null ? null : followOnce(followed, page.nextUrl);
      } catch (error) {
        this.fail(acc, error);
        this.endFullSync(acc);
        return "failed";
      }

      this.learnOwnerName(acc, page.meetings);
      for (const m of page.meetings) {
        const meetingHalt = halted(signal);
        if (meetingHalt !== null) return meetingHalt;
        if (seen.has(m.id) || !keepMeeting(m, run.settings, null)) continue;
        if (owners.some((email) => ownsMeeting(m, email))) continue;
        seen.add(m.id);
        await this.processMeeting(run, acc, m);
        if (!acc.result.ok) {
          this.endFullSync(acc);
          return "failed";
        }
        progress();
      }

      if (next === null) {
        this.endFullSync(acc);
        return "done";
      }
      cursorUrl = next;
      device.update(acc.config.id, { fullSyncActive: true, fullSyncCursor: cursorUrl });
    }
  }

  /**
   * Writes one meeting through the account chosen to write it, then brings its daily note up to
   * date. Its failures are not thrown: a failed meeting is counted on the account, and an auth,
   * rate-limit or invalid-response error on its transcript fails the account for the rest of the run.
   */
  private async processMeeting(run: Run, acc: AccountRun, m: Meeting): Promise<void> {
    const ctx = this.writeContext(run, acc);
    const forbidden = this.deps.device.account(acc.config.id).forbiddenTranscripts ?? {};
    const expectTranscript = run.settings.syncTranscripts && forbidden[m.id] !== m.updatedAt;

    let files: WriteResult;
    if (run.writer.isCurrent(m, ctx, expectTranscript)) {
      // Nothing to fetch or write; the daily note is still checked below.
      files = { ...run.writer.existing(m, ctx), oldStart: null };
    } else {
      let transcript: TranscriptSegment[] | null = null;
      if (expectTranscript) {
        try {
          transcript = await this.transcriptOf(acc, m);
        } catch (error) {
          if (error instanceof CirclebackError && STOPS_ACCOUNT.includes(error.kind)) {
            this.fail(acc, error);
          } else {
            logger.warn(`${where(acc, m)}: could not get the transcript; trying again next sync.`, error);
            acc.result.failed += 1;
          }
          return;
        }
      }
      try {
        files = await run.writer.write(m, transcript, ctx);
      } catch (error) {
        logger.error(`${where(acc, m)}: could not write it into the vault; trying again next sync.`, error);
        acc.result.failed += 1;
        return;
      }
    }

    let changed = files.changed;
    if (run.settings.saveAs === "sections") {
      // The block is the meeting's note, so it is written only while notes are synced.
      if (run.settings.syncNotes) {
        const blockChanged = await this.writeBlock(run, acc, m);
        if (blockChanged === null) {
          acc.result.failed += 1;
          return;
        }
        changed ||= blockChanged;
      }
    } else if (run.settings.linkFromDailyNotes && files.note !== null) {
      await this.linkNote(run, acc, m, files.note, files.oldStart);
    }
    if (changed) acc.result.written += 1;
    else acc.result.skipped += 1;
  }

  /**
   * The meeting's transcript, or null when there is none to write. A 403 is recorded against the
   * meeting's `updatedAt`, so it is not asked for again until the meeting changes. An empty
   * transcript is not ready yet, and is asked for again next run.
   */
  private async transcriptOf(acc: AccountRun, m: Meeting): Promise<TranscriptSegment[] | null> {
    const segments = await acc.client.getTranscript(m.id);
    const { device } = this.deps;
    const forbidden = device.account(acc.config.id).forbiddenTranscripts ?? {};
    if (segments === null) {
      logger.info(`${where(acc, m)}: this key may not read the transcript; not asking again until the meeting changes.`);
      device.update(acc.config.id, { forbiddenTranscripts: { ...forbidden, [m.id]: m.updatedAt } });
      return null;
    }
    if (m.id in forbidden) {
      delete forbidden[m.id];
      device.update(acc.config.id, { forbiddenTranscripts: forbidden });
    }
    return segments.length > 0 ? segments : null;
  }

  /** Sections mode: the meeting's block in its daily note. Whether the note changed; null when it could not be written. */
  private async writeBlock(run: Run, acc: AccountRun, m: Meeting): Promise<boolean | null> {
    const { settings } = run;
    // Never the transcript: see `writerSettingsFor`.
    const block = buildNoteBody(m, {
      includePrivateNotes: settings.includePrivateNotes,
      includeActionItems: settings.includeActionItems,
      includeInsights: settings.includeInsights,
    });
    try {
      return await run.dailyNotes.writeSection(m, block, settings, run.nowLocal);
    } catch (error) {
      logger.warn(`${where(acc, m)}: could not write it into its daily note; trying again next sync.`, error);
      return null;
    }
  }

  /** Files mode: the meeting's line in its daily note. A failure is logged, and the next run tries again. */
  private async linkNote(run: Run, acc: AccountRun, m: Meeting, note: TFile, oldStart: string | null): Promise<void> {
    try {
      await run.dailyNotes.linkMeeting(note, m, oldStart, run.settings, run.nowLocal);
    } catch (error) {
      logger.warn(`${where(acc, m)}: could not link it from its daily note; trying again next sync.`, error);
    }
  }

  /** On an account's first run on this device, learns from the key whose account it is. */
  private async setUp(acc: AccountRun): Promise<void> {
    if (acc.ownerEmail !== "") return;
    const { email } = await acc.client.testConnection();
    acc.ownerEmail = email;
    this.deps.device.update(acc.config.id, { ownerEmail: email });
  }

  /** Remembers the owner's name from the first meeting that gives one, to label their lines in transcripts. */
  private learnOwnerName(acc: AccountRun, meetings: Meeting[]): void {
    if (acc.ownerName !== null) return;
    for (const m of meetings) {
      const name = nonBlank(findOwner(m, acc.ownerEmail)?.name);
      if (name !== null) {
        acc.ownerName = name;
        this.deps.device.update(acc.config.id, { ownerName: name });
        return;
      }
    }
  }

  private fail(acc: AccountRun, error: unknown): void {
    const kind: AccountErrorKind = error instanceof CirclebackError ? error.kind : "unexpected";
    acc.result.ok = false;
    acc.result.error = kind;
    logger.error(`Circleback account "${acc.config.label}" could not sync (${kind}).`, error);
  }

  private endFullSync(acc: AccountRun): void {
    this.deps.device.update(acc.config.id, { fullSyncActive: undefined, fullSyncCursor: undefined });
  }

  /** The accounts that sync on this device, in settings order: sync on this device is on, and the account has a key here. */
  private eligibleAccounts(settings: CirclebackSyncSettings): AccountRun[] {
    const { device, keys } = this.deps;
    if (!device.syncOnThisDevice) return [];
    const accounts: AccountRun[] = [];
    for (const config of settings.accounts) {
      const key = keys.get(config.id);
      if (key === null) continue;
      const state = device.account(config.id);
      accounts.push({
        config,
        client: this.deps.clientFor(key),
        ownerEmail: state.ownerEmail ?? "",
        ownerName: nonBlank(state.ownerName),
        result: { ok: true, written: 0, skipped: 0, failed: 0 },
      });
    }
    return accounts;
  }

  private async openRun(settings: CirclebackSyncSettings, force: boolean): Promise<Run> {
    const { app } = this.deps;
    const dailyFolder = (await readDailyNoteConfig(app)).folder;
    const folders = indexFolders(settings, dailyFolder);
    const index = new MeetingIndex(app, () => folders);
    await index.build();
    const now = this.deps.now();
    return {
      settings,
      writerSettings: writerSettingsFor(settings),
      index,
      writer: new NoteWriter(app, index),
      dailyNotes: new DailyNotes(app, index),
      dailyFolder,
      force,
      now,
      nowLocal: moment.utc(now.getTime()).local(),
    };
  }

  private writeContext(run: Run, acc: AccountRun): WriteContext {
    const override = acc.config.selfNameOverride.trim();
    return {
      settings: run.writerSettings,
      accountLabel: acc.config.label,
      ownerEmail: acc.ownerEmail,
      ownerName: override !== "" ? override : acc.ownerName,
      dailyFolder: run.dailyFolder,
      force: run.force,
      now: () => this.deps.now(),
    };
  }

  /** Records each account's outcome in device state, then reports (and maybe cleans up) duplicates. */
  private async finish(run: Run, accounts: AccountRun[]): Promise<RunResult> {
    const at = this.deps.now().toISOString();
    const perAccount: Record<string, AccountResult> = {};
    for (const acc of accounts) {
      const { result } = acc;
      perAccount[acc.config.id] = result;
      const patch: Partial<AccountDeviceState> = result.ok
        ? { lastSuccessAt: at, failing: false, lastError: undefined }
        : { failing: true, lastError: result.error };
      const rateLimit = acc.client.rateLimit;
      if (rateLimit !== undefined) patch.rateLimit = rateLimit;
      this.deps.device.update(acc.config.id, patch);
      logger.info(
        `Circleback account "${acc.config.label}": ${result.written} written, ${result.skipped} up to date, ` +
          `${result.failed} failed${result.ok ? "" : `; stopped (${result.error})`}.`,
      );
    }

    let duplicates = findDuplicates(run.index);
    if (run.settings.cleanUpDuplicates && duplicates.length > 0) {
      await cleanUpDuplicates(this.deps.app, duplicates, run.index);
      duplicates = findDuplicates(run.index);
    }
    return { perAccount, duplicates };
  }
}

/** Why a full sync has to stop now, if it does. The user's cancel wins over Obsidian closing. */
function halted(signal: FullSyncSignal): "cancelled" | "stopped" | null {
  if (signal.cancelled) return "cancelled";
  return signal.stopped === true ? "stopped" : null;
}

function ownershipFor(settings: CirclebackSyncSettings): "Mine" | "All" {
  return settings.includeShared ? "All" : "Mine";
}

/**
 * The settings the note writer gets. In sections mode a combined transcript is written as a file
 * of its own beside the daily notes instead: a block inside a daily note has nowhere to keep the
 * state that says its transcript is current, so the transcript would be fetched on every run.
 */
function writerSettingsFor(settings: CirclebackSyncSettings): CirclebackSyncSettings {
  if (settings.saveAs !== "sections" || settings.transcriptHandling !== "combined") return settings;
  return { ...settings, transcriptHandling: "same-location" };
}

/**
 * The folders the index reads directly when the metadata cache has not reached a file yet: where
 * notes go, where transcripts go when they have their own place, and the daily notes in sections
 * mode. "" is the vault root.
 */
function indexFolders(settings: CirclebackSyncSettings, dailyFolder: string): string[] {
  const folders = [settings.baseFolderType === "custom" ? settings.customBaseFolder : dailyFolder];
  if (settings.transcriptHandling === "custom-location") folders.push(settings.customTranscriptBaseFolder);
  if (settings.saveAs === "sections") folders.push(dailyFolder);
  return folders;
}

/**
 * The next page's link, unless this listing has already followed it: then Circleback is going
 * round in circles, and paging on would hold the sync lock forever.
 */
function followOnce(followed: Set<string>, url: string): string {
  if (followed.has(url)) {
    throw new CirclebackError(
      "invalid-response",
      "Circleback's list of meetings points back to a page it already gave, so it would never end. " +
        "Circleback may have changed its API; look for a plugin update.",
    );
  }
  followed.add(url);
  return url;
}

function nonBlank(text: string | null | undefined): string | null {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** Names the account and meeting in a log line. */
function where(acc: AccountRun, m: Meeting): string {
  return `Circleback account "${acc.config.label}", meeting "${meetingTitle(m)}"`;
}
