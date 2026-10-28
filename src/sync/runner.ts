// Runs syncs for the commands, the scheduler and the settings tab, and tells the user how they went.
//
// The engine does the syncing; this wraps each run with what the user sees. Before a run it checks
// the things a person can fix (the vault still loading, "Sync on this device" off, no key here) and
// says so. After it, it works out which accounts stopped or recovered, whether duplicates grew, and
// what the run changed, and it keeps the full-sync progress for the status bar.
//
// One run at a time through this class, the same as the engine's lock. Keeping the flag here too
// means a second request never touches the first run's progress or its cancel signal.
//
// The public methods never throw or reject: they are called as `void runner.syncNow()`, where a
// rejection would vanish, so anything that goes wrong is logged instead.
import type { KeyStore } from "../secrets/keyStore";
import type { CirclebackSyncSettings } from "../settings/types";
import type { AccountDeviceState, DeviceState } from "../state/deviceState";
import {
  BUSY_NOTICE,
  CRASHED_NOTICE,
  FULL_SYNC_CANCELLED,
  FULL_SYNC_RESUMING,
  FULL_SYNC_STARTED,
  FULL_SYNC_STOPPING,
  NO_FULL_SYNC,
  NO_KEY_NOTICE,
  SYNC_OFF_NOTICE,
  WAITING_FOR_VAULT,
  duplicateNotice,
  resultNotice,
  transitionNotices,
} from "../ui/notices";
import { SYNC_OFF_TEXT, statusText, type StatusAccount } from "../ui/status";
import { logger } from "../util/logger";
import type { DuplicateGroup } from "../vault/duplicates";
import type { Readiness } from "./readiness";
import type { FullSyncSignal, RunResult, SyncEngine } from "./syncEngine";

export interface RunnerDeps {
  engine: Pick<SyncEngine, "sync" | "fullSync">;
  settings: () => CirclebackSyncSettings;
  keys: Pick<KeyStore, "get">;
  device: DeviceState;
  readiness: Pick<Readiness, "isReady" | "whenReady">;
  notify: (message: string) => void;
  /** Called whenever the status bar text may have changed. */
  onStatusChange: () => void;
}

/** What kind of run this is, which decides what the user is told. */
interface RunKind {
  /** A full sync, started by the user or resumed by the scheduler. */
  full: boolean;
  /** Asked for by the user (a command or a button), not by the scheduler. */
  manual: boolean;
}

export class SyncRunner {
  private running = false;
  /** Set when the plugin unloads. A run still going finishes its work but says nothing more. */
  private unloaded = false;
  /** The signal of the full sync that is running, if one is. */
  private signal: FullSyncSignal | null = null;
  private progress: { done: number } | null = null;
  private lastDuplicates: DuplicateGroup[] = [];
  /** Whether the last run ended in a thrown error, so a scheduler that keeps failing speaks up once. */
  private lastThrew = false;

  constructor(private readonly deps: RunnerDeps) {}

  /** "Sync now": waits for the vault, then runs a normal sync and says how it went. */
  async syncNow(): Promise<void> {
    await this.guarded(async () => {
      if (!(await this.prepare())) return;
      await this.execute({ full: false, manual: true });
    });
  }

  /**
   * What the scheduler calls. A full sync that Obsidian closed on is resumed in place of a normal
   * sync; otherwise this is a normal sync. Neither is user-started, so both stay quiet unless
   * something needs saying.
   */
  async syncScheduled(): Promise<void> {
    await this.guarded(() => this.execute({ full: this.hasUnfinishedFullSync(), manual: false }));
  }

  async startFullSync(): Promise<void> {
    await this.guarded(async () => {
      if (!(await this.prepare())) return;
      await this.execute({ full: true, manual: true });
    });
  }

  /** Stops the full sync after the current meeting and forgets where it was. */
  cancelFullSync(): void {
    try {
      if (this.signal === null) {
        this.say(NO_FULL_SYNC);
        return;
      }
      this.signal.cancelled = true;
      this.say(FULL_SYNC_STOPPING);
    } catch (error) {
      logger.error("Could not cancel the full sync.", error);
    }
  }

  /**
   * Obsidian is closing. A running full sync stops at the next meeting but keeps its place, so it
   * resumes later (never `cancelled`, which would clear where it was). Any run still going
   * finishes its work, but its notices and status refreshes are dropped.
   */
  stopForUnload(): void {
    this.unloaded = true;
    if (this.signal !== null) this.signal.stopped = true;
  }

  /** How far the running full sync is, or null when none is running. */
  get fullSyncProgress(): { done: number } | null {
    return this.progress === null ? null : { ...this.progress };
  }

  /** The meetings that still had more than one file after the last run that synced any account. */
  get duplicates(): DuplicateGroup[] {
    return this.lastDuplicates;
  }

  /** The status bar text; empty when there are no accounts. */
  statusText(): string {
    const { accounts } = this.deps.settings();
    if (accounts.length === 0) return "";
    // A full sync that is running keeps its progress on show, even if the toggle is switched off meanwhile.
    if (this.progress === null && !this.deps.device.syncOnThisDevice) return SYNC_OFF_TEXT;
    const perAccount: Record<string, StatusAccount> = {};
    for (const account of accounts) {
      perAccount[account.id] = {
        ...this.deps.device.account(account.id),
        label: account.label,
        hasKey: this.deps.keys.get(account.id) !== null,
      };
    }
    return statusText(perAccount, this.fullSyncProgress ?? undefined);
  }

  /** Runs `work`, logging instead of rejecting if it fails. */
  private async guarded(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      logger.error("The sync could not be run.", error);
    }
  }

  /** Shows a notice, unless the plugin has been unloaded. */
  private say(message: string): void {
    if (!this.unloaded) this.deps.notify(message);
  }

  /** Tells the status bar to refresh, unless the plugin has been unloaded. */
  private statusChanged(): void {
    if (!this.unloaded) this.deps.onStatusChange();
  }

  /** Before a manual or full sync: waits for the vault, and stops with a notice if the sync cannot run here. */
  private async prepare(): Promise<boolean> {
    const { readiness, device, keys, settings } = this.deps;
    if (!readiness.isReady) {
      this.say(WAITING_FOR_VAULT);
      await readiness.whenReady();
    }
    if (!device.syncOnThisDevice) {
      this.say(SYNC_OFF_NOTICE);
      return false;
    }
    if (!settings().accounts.some((account) => keys.get(account.id) !== null)) {
      this.say(NO_KEY_NOTICE);
      return false;
    }
    return true;
  }

  private hasUnfinishedFullSync(): boolean {
    const { settings, keys, device } = this.deps;
    return settings().accounts.some(
      (account) => keys.get(account.id) !== null && device.account(account.id).fullSyncActive === true,
    );
  }

  private async execute(kind: RunKind): Promise<void> {
    if (this.running) {
      this.notifyBusy(kind);
      return;
    }
    this.running = true;
    const signal: FullSyncSignal | null = kind.full ? { cancelled: false, stopped: false } : null;
    let before: Record<string, AccountDeviceState> = {};
    let outcome: RunResult | "busy" | null = null;
    // Everything after `running` is set is inside the try, so that nothing that throws (a notice,
    // the status bar, the device state) can leave the runner thinking a run is still going.
    try {
      if (signal !== null) {
        this.signal = signal;
        this.progress = { done: 0 };
        // A resume that follows a run that threw is not announced again; the crash notice said it once.
        if (kind.manual || !this.lastThrew) this.say(kind.manual ? FULL_SYNC_STARTED : FULL_SYNC_RESUMING);
        this.statusChanged();
      }
      // Before the engine runs: its `finish` overwrites `failing`, which is what a notice compares with.
      before = this.snapshot();
      outcome =
        signal === null
          ? await this.deps.engine.sync()
          : await this.deps.engine.fullSync((done) => {
              this.progress = { done };
              this.statusChanged();
            }, signal);
      if (outcome !== "busy") this.lastThrew = false;
    } catch (error) {
      this.crashed(error, kind);
    } finally {
      this.running = false;
      this.signal = null;
      this.progress = null;
    }

    // Once unloaded, the report would go to nobody.
    if (!this.unloaded) {
      if (outcome === "busy") this.notifyBusy(kind);
      else if (outcome !== null) this.report(outcome, before, kind, signal?.cancelled === true);
    }
    this.statusChanged();
  }

  /** Each configured account's device state as it is now. */
  private snapshot(): Record<string, AccountDeviceState> {
    const before: Record<string, AccountDeviceState> = {};
    for (const account of this.deps.settings().accounts) before[account.id] = this.deps.device.account(account.id);
    return before;
  }

  /** A scheduled run that finds the engine busy has nothing to tell the user. */
  private notifyBusy(kind: RunKind): void {
    if (kind.manual) this.say(BUSY_NOTICE);
  }

  /**
   * An error the engine threw: a bug or a vault error during setup, not an account failing. The
   * user always hears about one they asked for. A scheduled run (including a resumed full sync)
   * says so only for the first in a streak, so a failure that repeats every interval is not
   * announced every interval.
   */
  private crashed(error: unknown, kind: RunKind): void {
    logger.error("The sync failed with an unexpected error.", error);
    const first = !this.lastThrew;
    this.lastThrew = true;
    if (kind.manual || first) this.say(CRASHED_NOTICE);
  }

  private report(result: RunResult, before: Record<string, AccountDeviceState>, kind: RunKind, cancelled: boolean): void {
    const settings = this.deps.settings();
    const messages: Array<string | null> = [];
    for (const [id, outcome] of Object.entries(result.perAccount)) {
      // An account removed while the run was going has nothing left to report.
      const label = settings.accounts.find((account) => account.id === id)?.label;
      if (label !== undefined) messages.push(transitionNotices(before[id] ?? {}, outcome, label));
    }
    // A run that synced no account did not look at the vault, so its empty list says nothing.
    if (Object.keys(result.perAccount).length > 0) {
      messages.push(duplicateNotice(this.lastDuplicates.length, result.duplicates.length));
      this.lastDuplicates = result.duplicates;
    }
    messages.push(
      cancelled
        ? FULL_SYNC_CANCELLED
        : resultNotice(result, { manual: kind.manual, fullSync: kind.full, show: settings.showSyncNotifications }),
    );
    for (const message of messages) {
      if (message !== null) this.say(message);
    }
  }
}
