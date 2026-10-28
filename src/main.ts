// Plugin entry point: builds the parts, wires them together, and registers commands. The work
// itself lives in the modules it builds: the runner decides what a run says, the scheduler when
// it starts, and the readiness gate when the vault is safe to touch.
import { Notice, Plugin } from "obsidian";
import { CirclebackClient } from "./api/circlebackClient";
import { HttpClient } from "./api/http";
import { KeyStore } from "./secrets/keyStore";
import { SettingsStore } from "./settings/settingsStore";
import { DeviceState } from "./state/deviceState";
import { Readiness } from "./sync/readiness";
import { SyncRunner } from "./sync/runner";
import { Scheduler, minutesToMs } from "./sync/scheduler";
import { SyncEngine } from "./sync/syncEngine";
import { CirclebackSettingTab } from "./ui/settingsTab";
import { logger } from "./util/logger";
import type { Timers } from "./util/timers";

const windowTimers: Timers = {
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

export default class CirclebackSyncPlugin extends Plugin {
  // One of each, shared by everything: two DeviceState instances would overwrite each other.
  readonly settingsStore = new SettingsStore(this);
  readonly keys = new KeyStore(this.app);
  readonly device = new DeviceState(this.app);

  private syncRunner: SyncRunner | null = null;
  private statusEl: HTMLElement | null = null;
  private settingTab: CirclebackSettingTab | null = null;

  /** Runs every sync; the commands, the scheduler and the settings tab all go through it. */
  get runner(): SyncRunner {
    if (this.syncRunner === null) throw new Error("Circleback Sync has not finished loading.");
    return this.syncRunner;
  }

  async onload(): Promise<void> {
    // First, before any await: the cache's first `resolved` event can fire while data.json is
    // being read, and a gate built after that would never see it. It needs no settings.
    const readiness = new Readiness({
      app: this.app,
      registerEvent: (ref) => this.registerEvent(ref),
      ...windowTimers,
    });

    const settings = await this.settingsStore.load();
    logger.setDebug(settings.debugLogging);

    const engine = new SyncEngine({
      app: this.app,
      settings: () => this.settingsStore.current,
      keys: this.keys,
      device: this.device,
      clientFor: (key) => this.clientFor(key),
      now: () => new Date(),
    });

    this.statusEl = this.addStatusBarItem();
    const runner = new SyncRunner({
      engine,
      settings: () => this.settingsStore.current,
      keys: this.keys,
      device: this.device,
      readiness,
      notify: (message) => {
        new Notice(message);
      },
      onStatusChange: () => this.refreshStatus(),
    });
    this.syncRunner = runner;
    const scheduler = new Scheduler({
      run: () => runner.syncScheduled(),
      intervalMs: () => minutesToMs(this.settingsStore.current.syncIntervalMinutes, 1, 1440, 30),
      settleMs: () => minutesToMs(this.settingsStore.current.settleDelayMinutes, 0, 1440, 10),
      enabled: () => this.settingsStore.current.periodicSync && this.device.syncOnThisDevice,
      now: Date.now,
      ...windowTimers,
    });

    // The settings store has no way to remove a listener, so this is the only one.
    this.settingsStore.onChange((next) => {
      logger.setDebug(next.debugLogging);
      this.refreshStatus();
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => {
        void runner.syncNow();
      },
    });
    this.addCommand({
      id: "full-sync",
      name: "Full sync",
      callback: () => {
        void runner.startFullSync();
      },
    });
    this.addCommand({
      id: "cancel-full-sync",
      name: "Cancel full sync",
      callback: () => {
        runner.cancelFullSync();
      },
    });

    this.settingTab = new CirclebackSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    // The first automatic sync comes a settle delay after this, not at once.
    void readiness.whenReady().then(() => scheduler.start());
    this.register(() => {
      scheduler.stop();
      runner.stopForUnload();
      readiness.dispose();
    });

    this.refreshStatus();
  }

  /** Another device changed data.json: reload, so a stale copy never overwrites the newer settings. */
  async onExternalSettingsChange(): Promise<void> {
    await this.settingsStore.reloadFromDisk();
  }

  /**
   * Sets the status bar text from the current state; hides the item when there is nothing to say.
   * The settings tab is told too, since a full sync starting or ending changes its button.
   */
  refreshStatus(): void {
    if (this.statusEl === null || this.syncRunner === null) return;
    const text = this.syncRunner.statusText();
    this.statusEl.setText(text);
    if (text === "") this.statusEl.hide();
    else this.statusEl.show();
    this.settingTab?.refreshFullSyncButton();
  }

  /** A Circleback client for one API key: the engine's factory, also used by "Test connection". */
  clientFor(key: string): CirclebackClient {
    return new CirclebackClient(new HttpClient(key));
  }
}
