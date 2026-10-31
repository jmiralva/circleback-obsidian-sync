import { KeyStore } from "../../src/secrets/keyStore";
import { DEFAULT_SETTINGS, type AccountConfig, type CirclebackSyncSettings } from "../../src/settings/types";
import { DeviceState } from "../../src/state/deviceState";
import { SyncRunner } from "../../src/sync/runner";
import type { AccountResult, FullSyncSignal, RunResult, SyncEngine } from "../../src/sync/syncEngine";
import { SYNC_OFF_TEXT } from "../../src/ui/status";
import { logger } from "../../src/util/logger";
import type { DuplicateGroup } from "../../src/vault/duplicates";
import { deferred } from "../harness/deferred";
import { createFakeApp } from "../harness/fakeApp";

const A: AccountConfig = { id: "a", label: "Work", selfNameOverride: "" };
const B: AccountConfig = { id: "b", label: "Personal", selfNameOverride: "" };

const WAITING = "Circleback Sync: waiting for Obsidian to finish loading the vault.";
const OFF = 'Circleback Sync: syncing is off on this device. Turn on "Sync on this device" in the plugin settings.';
const NO_KEY = "Circleback Sync: no account has an API key on this device. Add one in the plugin settings.";
const BUSY = "Circleback Sync: a sync is already running.";
const CRASHED =
  'Circleback Sync: the sync failed because of an unexpected error. Use "Copy logs" in the plugin settings for details.';
const FULL_STARTED = "Circleback Sync: full sync started. Progress is in the status bar.";
const RESUMING = "Circleback Sync: resuming the full sync.";

function ok(changes: Partial<AccountResult> = {}): AccountResult {
  return { ok: true, written: 0, skipped: 0, failed: 0, ...changes };
}

function run(perAccount: Record<string, AccountResult>, duplicates: DuplicateGroup[] = []): RunResult {
  return { perAccount, duplicates };
}

/** A duplicate group; the runner only counts them. */
function dupes(count: number): DuplicateGroup[] {
  return Array.from({ length: count }, (_, i) => ({ id: `m${i}`, kind: "note", keep: {}, others: [{}] }) as unknown as DuplicateGroup);
}

interface Setup {
  runner: SyncRunner;
  engine: { sync: jest.Mock<Promise<RunResult | "busy">, []>; fullSync: jest.Mock<Promise<RunResult | "busy">, [(done: number) => void, FullSyncSignal]> };
  device: DeviceState;
  keys: KeyStore;
  settings: CirclebackSyncSettings;
  notices: string[];
  statusChanges: { count: number };
  readiness: { isReady: boolean; whenReady: jest.Mock<Promise<void>, []> };
  /** What the runner's `notify` and `onStatusChange` do. A test may replace them, for instance to make one throw. */
  hooks: { notify: (message: string) => void; onStatusChange: () => void };
}

function setup(opts: { accounts?: AccountConfig[]; withKeys?: string[]; settings?: Partial<CirclebackSyncSettings>; ready?: boolean } = {}): Setup {
  const app = createFakeApp();
  const keys = new KeyStore(app);
  const device = new DeviceState(app);
  const accounts = opts.accounts ?? [A];
  for (const id of opts.withKeys ?? accounts.map((account) => account.id)) keys.set(id, `cb_key_${id}`);
  const settings: CirclebackSyncSettings = { ...DEFAULT_SETTINGS, accounts, ...opts.settings };
  const engine: Setup["engine"] = { sync: jest.fn(), fullSync: jest.fn() };
  engine.sync.mockResolvedValue(run({}));
  engine.fullSync.mockResolvedValue(run({}));
  const notices: string[] = [];
  const statusChanges = { count: 0 };
  const readiness = { isReady: opts.ready ?? true, whenReady: jest.fn(() => Promise.resolve()) };
  const hooks: Setup["hooks"] = {
    notify: (message) => {
      notices.push(message);
    },
    onStatusChange: () => {
      statusChanges.count += 1;
    },
  };
  const runner = new SyncRunner({
    engine: engine as unknown as Pick<SyncEngine, "sync" | "fullSync">,
    settings: () => settings,
    keys,
    device,
    readiness,
    notify: (message) => hooks.notify(message),
    onStatusChange: () => hooks.onStatusChange(),
  });
  return { runner, engine, device, keys, settings, notices, statusChanges, readiness, hooks };
}

describe("SyncRunner.syncNow", () => {
  it("runs a sync and tells the user what changed", async () => {
    const { runner, engine, notices, statusChanges } = setup();
    engine.sync.mockResolvedValue(run({ a: ok({ written: 2 }) }));

    await runner.syncNow();

    expect(engine.sync).toHaveBeenCalledTimes(1);
    expect(notices).toEqual(["Circleback Sync: 2 meetings updated."]);
    expect(statusChanges.count).toBeGreaterThan(0);
  });

  it("tells the user when everything is up to date, even with sync notifications off", async () => {
    const { runner, engine, notices } = setup({ settings: { showSyncNotifications: false } });
    engine.sync.mockResolvedValue(run({ a: ok({ skipped: 3 }) }));

    await runner.syncNow();

    expect(notices).toEqual(["Circleback Sync: everything is up to date."]);
  });

  it("waits for the vault to be ready, and says so", async () => {
    const { runner, engine, notices, readiness } = setup({ ready: false });
    const gate = deferred();
    readiness.whenReady.mockReturnValue(gate.promise);

    const pending = runner.syncNow();
    await Promise.resolve();

    expect(notices).toEqual([WAITING]);
    expect(engine.sync).not.toHaveBeenCalled();

    gate.resolve();
    await pending;
    expect(engine.sync).toHaveBeenCalledTimes(1);
  });

  it("does not mention waiting when the vault is ready", async () => {
    const { runner, notices } = setup({ ready: true });
    await runner.syncNow();
    expect(notices).not.toContain(WAITING);
  });

  it("stops with a notice when sync on this device is off", async () => {
    const { runner, engine, device, notices } = setup();
    device.syncOnThisDevice = false;

    await runner.syncNow();

    expect(notices).toEqual([OFF]);
    expect(engine.sync).not.toHaveBeenCalled();
  });

  it("stops with a notice when no account has a key on this device", async () => {
    const { runner, engine, notices } = setup({ accounts: [A, B], withKeys: [] });

    await runner.syncNow();

    expect(notices).toEqual([NO_KEY]);
    expect(engine.sync).not.toHaveBeenCalled();
  });

  it("says a sync is already running when the engine is busy", async () => {
    const { runner, engine, notices } = setup();
    engine.sync.mockResolvedValue("busy");

    await runner.syncNow();

    expect(notices).toEqual([BUSY]);
  });

  it("says a sync is already running when called while one of its own is still going", async () => {
    const { runner, engine, notices } = setup();
    const gate = deferred();
    engine.sync.mockImplementationOnce(async () => {
      await gate.promise;
      return run({ a: ok() });
    });

    const first = runner.syncNow();
    await Promise.resolve();
    await runner.syncNow();

    expect(engine.sync).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([BUSY]);
    gate.resolve();
    await first;
  });

  it("notifies when an account stops syncing, once, and again when it recovers", async () => {
    const { runner, engine, device, notices } = setup({ accounts: [A, B] });
    // What the real engine does at the end of a run: records each account's outcome.
    const engineRuns = (b: AccountResult): void => {
      engine.sync.mockImplementation(async () => {
        device.update("a", { failing: false });
        device.update("b", { failing: !b.ok });
        return run({ a: ok(), b });
      });
    };

    engineRuns(ok({ ok: false, error: "auth" }));
    await runner.syncNow();
    expect(notices).toEqual([
      'Circleback Sync: "Personal" stopped syncing because the API key was not accepted. Check its API key in the plugin settings.',
      "Circleback Sync: no meetings updated. 1 account could not sync; see the status bar.",
    ]);

    // Still failing: no second notice about the account stopping.
    notices.length = 0;
    await runner.syncNow();
    expect(notices.some((n) => n.includes("stopped syncing"))).toBe(false);

    // Working again.
    notices.length = 0;
    engineRuns(ok());
    await runner.syncNow();
    expect(notices).toEqual(['Circleback Sync: "Personal" is syncing again.', "Circleback Sync: everything is up to date."]);
  });

  it("compares with the device state from before the run, because the engine overwrites it", async () => {
    const { runner, engine, device, notices } = setup();
    engine.sync.mockImplementation(async () => {
      // What the engine's `finish` does.
      device.update("a", { failing: true, lastError: "network" });
      return run({ a: ok({ ok: false, error: "network" }) });
    });
    await runner.syncNow();
    expect(notices[0]).toContain('"Work" stopped syncing because there was no connection to Circleback');

    notices.length = 0;
    engine.sync.mockImplementation(async () => {
      device.update("a", { failing: false, lastError: undefined });
      return run({ a: ok() });
    });
    await runner.syncNow();
    expect(notices[0]).toBe('Circleback Sync: "Work" is syncing again.');
  });

  it("mentions duplicates when their number grows, and keeps them for the settings tab", async () => {
    const { runner, engine, notices } = setup();
    expect(runner.duplicates).toEqual([]);

    engine.sync.mockResolvedValue(run({ a: ok() }, dupes(2)));
    await runner.syncNow();
    expect(notices).toContain("Circleback Sync found 2 meetings with duplicate notes. See the plugin settings.");
    expect(runner.duplicates).toHaveLength(2);

    notices.length = 0;
    await runner.syncNow();
    expect(notices.some((n) => n.includes("duplicate"))).toBe(false);

    engine.sync.mockResolvedValue(run({ a: ok() }, dupes(3)));
    await runner.syncNow();
    expect(notices).toContain("Circleback Sync found 3 meetings with duplicate notes. See the plugin settings.");

    // Fewer, then more again: the count that grew is compared with the last run's.
    engine.sync.mockResolvedValue(run({ a: ok() }, dupes(1)));
    await runner.syncNow();
    notices.length = 0;
    engine.sync.mockResolvedValue(run({ a: ok() }, dupes(2)));
    await runner.syncNow();
    expect(notices.some((n) => n.includes("2 meetings with duplicate notes"))).toBe(true);
  });

  it("keeps the last duplicates when a run synced no account", async () => {
    const { runner, engine, notices } = setup();
    engine.sync.mockResolvedValue(run({ a: ok() }, dupes(2)));
    await runner.syncNow();

    engine.sync.mockResolvedValue(run({}));
    await runner.syncNow();

    expect(runner.duplicates).toHaveLength(2);
    notices.length = 0;
    engine.sync.mockResolvedValue(run({ a: ok() }, dupes(2)));
    await runner.syncNow();
    expect(notices.some((n) => n.includes("duplicate"))).toBe(false);
  });

  it("has the run's duplicates and account state in place when it tells the settings tab the run is over", async () => {
    const { runner, engine, device, hooks } = setup();
    const seen: Array<{ duplicates: number; lastSuccessAt: string | undefined }> = [];
    hooks.onStatusChange = () => {
      seen.push({ duplicates: runner.duplicates.length, lastSuccessAt: device.account("a").lastSuccessAt });
    };
    engine.sync.mockImplementation(async () => {
      device.update("a", { lastSuccessAt: "2026-10-31T15:00:00.000Z" });
      return run({ a: ok() }, dupes(2));
    });

    await runner.syncNow();

    // The settings tab redraws its duplicates and status lines from the last update of a run.
    expect(seen[seen.length - 1]).toEqual({ duplicates: 2, lastSuccessAt: "2026-10-31T15:00:00.000Z" });
  });

  it("catches an error the engine throws, logs it, and tells the user", async () => {
    const { runner, engine, notices, statusChanges } = setup();
    engine.sync.mockRejectedValue(new Error("vault exploded"));

    await expect(runner.syncNow()).resolves.toBeUndefined();

    expect(notices).toEqual([CRASHED]);
    expect(logger.dump()).toContain("vault exploded");
    expect(statusChanges.count).toBeGreaterThan(0);
  });

  it("is free to run again after the engine threw", async () => {
    const { runner, engine, notices } = setup();
    engine.sync.mockRejectedValueOnce(new Error("once"));
    await runner.syncNow();

    notices.length = 0;
    engine.sync.mockResolvedValue(run({ a: ok({ written: 1 }) }));
    await runner.syncNow();

    expect(notices).toEqual(["Circleback Sync: 1 meeting updated."]);
  });
});

describe("SyncRunner.syncScheduled", () => {
  it("runs a normal sync without a word when nothing was written", async () => {
    const { runner, engine, notices } = setup();
    engine.sync.mockResolvedValue(run({ a: ok({ skipped: 5 }) }));

    await runner.syncScheduled();

    expect(engine.sync).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
  });

  it("shows the success notice only when sync notifications are on", async () => {
    const on = setup();
    on.engine.sync.mockResolvedValue(run({ a: ok({ written: 2 }) }));
    await on.runner.syncScheduled();
    expect(on.notices).toEqual(["Circleback Sync: 2 meetings updated."]);

    const off = setup({ settings: { showSyncNotifications: false } });
    off.engine.sync.mockResolvedValue(run({ a: ok({ written: 2 }) }));
    await off.runner.syncScheduled();
    expect(off.notices).toEqual([]);
  });

  it("still reports an account that stops syncing, even with sync notifications off", async () => {
    const { runner, engine, notices } = setup({ settings: { showSyncNotifications: false } });
    engine.sync.mockResolvedValue(run({ a: ok({ ok: false, error: "rate-limited" }) }));

    await runner.syncScheduled();

    expect(notices).toEqual([
      'Circleback Sync: "Work" stopped syncing because Circleback\'s rate limit was reached. It will try again at the next sync.',
    ]);
  });

  it("stays silent when the engine is busy", async () => {
    const { runner, engine, notices } = setup();
    engine.sync.mockResolvedValue("busy");

    await runner.syncScheduled();

    expect(notices).toEqual([]);
  });

  it("does not check readiness or the device toggle itself; the scheduler does", async () => {
    const { runner, engine, notices, readiness } = setup({ ready: false });

    await runner.syncScheduled();

    expect(readiness.whenReady).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
    expect(engine.sync).toHaveBeenCalledTimes(1);
  });

  it("resumes an interrupted full sync instead of a normal sync", async () => {
    const { runner, engine, device, notices } = setup({ accounts: [A, B] });
    device.update("b", { fullSyncActive: true, fullSyncCursor: "https://circleback.ai/api/meetings?cursor=3" });
    engine.fullSync.mockResolvedValue(run({ b: ok({ written: 4 }) }));

    await runner.syncScheduled();

    expect(engine.sync).not.toHaveBeenCalled();
    expect(engine.fullSync).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([RESUMING, "Circleback Sync: full sync finished. 4 meetings updated."]);
  });

  it("ignores an interrupted full sync of an account that has no key on this device", async () => {
    const { runner, engine, device, notices } = setup({ accounts: [A, B], withKeys: ["a"] });
    device.update("b", { fullSyncActive: true });

    await runner.syncScheduled();

    expect(engine.fullSync).not.toHaveBeenCalled();
    expect(engine.sync).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
  });

  it("does nothing while a full sync it started is running", async () => {
    const { runner, engine, device, notices } = setup();
    const gate = deferred();
    engine.fullSync.mockImplementation(async () => {
      device.update("a", { fullSyncActive: true });
      await gate.promise;
      return run({ a: ok() });
    });
    const full = runner.startFullSync();
    await Promise.resolve();
    await Promise.resolve();
    notices.length = 0;

    await runner.syncScheduled();

    expect(engine.sync).not.toHaveBeenCalled();
    expect(engine.fullSync).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
    gate.resolve();
    await full;
  });

  it("tells the user about a thrown error only for the first failure after a run that did not throw", async () => {
    const { runner, engine, notices } = setup();
    engine.sync.mockRejectedValue(new Error("broken"));

    await runner.syncScheduled();
    await runner.syncScheduled();
    expect(notices).toEqual([CRASHED]);

    // A run that does not throw resets it.
    engine.sync.mockResolvedValueOnce(run({ a: ok() }));
    await runner.syncScheduled();
    await runner.syncScheduled();
    expect(notices).toEqual([CRASHED, CRASHED]);
  });

  it("stays silent about a scheduled failure that follows a manual run that threw", async () => {
    const { runner, engine, notices } = setup();
    engine.sync.mockRejectedValue(new Error("broken"));

    await runner.syncNow();
    await runner.syncScheduled();

    // The manual run always tells the user; the scheduled one follows a run that threw.
    expect(notices).toEqual([CRASHED]);
  });
});

describe("SyncRunner thrown errors in a resumed full sync", () => {
  /** A full sync that Obsidian closed on: account a is marked unfinished. */
  function interrupted(): Setup {
    const made = setup();
    made.device.update("a", { fullSyncActive: true, fullSyncCursor: "https://circleback.ai/api/meetings?cursor=2" });
    made.engine.fullSync.mockRejectedValue(new Error("resume broke"));
    return made;
  }

  it("tells the user once when a resumed full sync keeps throwing, not every interval", async () => {
    const { runner, notices } = interrupted();

    await runner.syncScheduled();
    expect(notices).toEqual([RESUMING, CRASHED]);

    // The scheduler tries again each interval and it throws again: nothing more to say.
    notices.length = 0;
    await runner.syncScheduled();
    await runner.syncScheduled();
    expect(notices).toEqual([]);
  });

  it("tells the user again after a run that did not throw", async () => {
    const { runner, engine, notices } = interrupted();
    await runner.syncScheduled();
    engine.fullSync.mockResolvedValueOnce(run({ a: ok({ written: 1 }) }));
    await runner.syncScheduled();
    notices.length = 0;

    engine.fullSync.mockRejectedValue(new Error("broke again"));
    await runner.syncScheduled();

    expect(notices).toEqual([RESUMING, CRASHED]);
  });

  it("always tells the user when a full sync they started, or Sync now, throws", async () => {
    const full = setup();
    full.engine.fullSync.mockRejectedValue(new Error("broke"));
    await full.runner.startFullSync();
    await full.runner.startFullSync();
    expect(full.notices).toEqual([FULL_STARTED, CRASHED, FULL_STARTED, CRASHED]);

    const now = setup();
    now.engine.sync.mockRejectedValue(new Error("broke"));
    await now.runner.syncNow();
    await now.runner.syncNow();
    expect(now.notices).toEqual([CRASHED, CRASHED]);
  });

  it("stays silent about busy, like any scheduled run", async () => {
    const { runner, engine, notices } = interrupted();
    engine.fullSync.mockResolvedValue("busy");

    await runner.syncScheduled();

    expect(notices).toEqual([RESUMING]);
  });
});

describe("SyncRunner when something around a run throws", () => {
  it("is free to run again after the start notice of a full sync throws", async () => {
    const { runner, engine, hooks, notices } = setup();
    let first = true;
    hooks.notify = (message) => {
      if (first) {
        first = false;
        throw new Error("the notice failed");
      }
      notices.push(message);
    };

    await expect(runner.startFullSync()).resolves.toBeUndefined();

    expect(runner.fullSyncProgress).toBeNull();
    engine.sync.mockResolvedValue(run({ a: ok({ written: 1 }) }));
    await runner.syncNow();
    expect(engine.sync).toHaveBeenCalledTimes(1);
    expect(notices).toContain("Circleback Sync: 1 meeting updated.");
    // Cancel finds no full sync left behind.
    notices.length = 0;
    runner.cancelFullSync();
    expect(notices).toEqual(["Circleback Sync: no full sync is running."]);
  });

  it("is free to run again after the first status refresh of a full sync throws", async () => {
    const { runner, engine, hooks } = setup();
    let first = true;
    hooks.onStatusChange = () => {
      if (first) {
        first = false;
        throw new Error("the status bar failed");
      }
    };

    await expect(runner.startFullSync()).resolves.toBeUndefined();

    expect(runner.fullSyncProgress).toBeNull();
    await runner.syncNow();
    expect(engine.sync).toHaveBeenCalledTimes(1);
  });

  it("is free to run again after reading the device state before the run throws", async () => {
    const { runner, engine, device } = setup();
    jest.spyOn(device, "account").mockImplementationOnce(() => {
      throw new Error("device state unreadable");
    });

    await expect(runner.syncNow()).resolves.toBeUndefined();

    expect(engine.sync).not.toHaveBeenCalled();
    await runner.syncNow();
    expect(engine.sync).toHaveBeenCalledTimes(1);
  });
});

describe("SyncRunner public methods", () => {
  it("never reject: a failure anywhere is logged instead", async () => {
    const waiting = setup({ ready: false });
    waiting.readiness.whenReady.mockRejectedValue(new Error("readiness failed"));
    await expect(waiting.runner.syncNow()).resolves.toBeUndefined();
    await expect(waiting.runner.startFullSync()).resolves.toBeUndefined();
    expect(logger.dump()).toContain("readiness failed");

    // The notice that reports the result throws.
    const reporting = setup();
    reporting.engine.sync.mockResolvedValue(run({ a: ok({ written: 1 }) }));
    reporting.hooks.notify = () => {
      throw new Error("could not show the result");
    };
    await expect(reporting.runner.syncNow()).resolves.toBeUndefined();
    await expect(reporting.runner.syncScheduled()).resolves.toBeUndefined();
    expect(logger.dump()).toContain("could not show the result");

    // The status refresh at the very end throws.
    const refreshing = setup();
    refreshing.hooks.onStatusChange = () => {
      throw new Error("could not refresh the status");
    };
    await expect(refreshing.runner.syncNow()).resolves.toBeUndefined();
    expect(logger.dump()).toContain("could not refresh the status");

    // Settings that cannot be read.
    const unreadable = setup();
    unreadable.settings.accounts = null as unknown as AccountConfig[];
    await expect(unreadable.runner.syncScheduled()).resolves.toBeUndefined();
    await expect(unreadable.runner.syncNow()).resolves.toBeUndefined();
  });

  it("do not throw: cancelling logs a notice that fails to show, and stopping for unload says nothing", () => {
    const { runner, engine, hooks } = setup();
    hooks.notify = () => {
      throw new Error("could not show the notice");
    };

    expect(() => runner.cancelFullSync()).not.toThrow();
    expect(() => runner.stopForUnload()).not.toThrow();
    expect(engine.fullSync).not.toHaveBeenCalled();
    expect(logger.dump()).toContain("could not show the notice");
  });
});

describe("SyncRunner full sync", () => {
  it("announces the start and reports progress and the end", async () => {
    const { runner, engine, notices, statusChanges } = setup();
    const midRun: Array<{ progress: { done: number } | null; status: string }> = [];
    engine.fullSync.mockImplementation(async (onProgress) => {
      onProgress(1);
      onProgress(2);
      midRun.push({ progress: runner.fullSyncProgress, status: runner.statusText() });
      return run({ a: ok({ written: 2 }) });
    });

    await runner.startFullSync();

    expect(midRun).toEqual([{ progress: { done: 2 }, status: "Circleback: full sync 2" }]);
    expect(notices).toEqual([FULL_STARTED, "Circleback Sync: full sync finished. 2 meetings updated."]);
    expect(runner.fullSyncProgress).toBeNull();
    expect(runner.statusText()).not.toContain("full sync");
    // Once at the start, once per progress step, once at the end.
    expect(statusChanges.count).toBeGreaterThanOrEqual(4);
  });

  it("reports the end of a full sync even with sync notifications off", async () => {
    const { runner, engine, notices } = setup({ settings: { showSyncNotifications: false } });
    engine.fullSync.mockResolvedValue(run({ a: ok({ written: 3 }) }));

    await runner.startFullSync();

    expect(notices).toEqual([FULL_STARTED, "Circleback Sync: full sync finished. 3 meetings updated."]);
  });

  it("checks readiness, the device toggle and keys first, as a manual sync does", async () => {
    const off = setup();
    off.device.syncOnThisDevice = false;
    await off.runner.startFullSync();
    expect(off.notices).toEqual([OFF]);
    expect(off.engine.fullSync).not.toHaveBeenCalled();

    const noKey = setup({ withKeys: [] });
    await noKey.runner.startFullSync();
    expect(noKey.notices).toEqual([NO_KEY]);

    const waiting = setup({ ready: false });
    await waiting.runner.startFullSync();
    expect(waiting.notices[0]).toBe(WAITING);
    expect(waiting.engine.fullSync).toHaveBeenCalledTimes(1);
  });

  it("says a sync is already running when the engine is busy, and leaves no progress behind", async () => {
    const { runner, engine, notices } = setup();
    engine.fullSync.mockResolvedValue("busy");

    await runner.startFullSync();

    expect(notices).toEqual([FULL_STARTED, BUSY]);
    expect(runner.fullSyncProgress).toBeNull();
  });

  it("does not start a second full sync, and a cancel still reaches the first", async () => {
    const { runner, engine, notices } = setup();
    const gate = deferred();
    let signal: FullSyncSignal | null = null;
    engine.fullSync.mockImplementation(async (_onProgress, given) => {
      signal = given;
      await gate.promise;
      return run({ a: ok() });
    });
    const first = runner.startFullSync();
    await Promise.resolve();
    await Promise.resolve();

    await runner.startFullSync();
    runner.cancelFullSync();

    expect(engine.fullSync).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([FULL_STARTED, BUSY, "Circleback Sync: stopping the full sync after the current meeting."]);
    expect(signal).toMatchObject({ cancelled: true });
    gate.resolve();
    await first;
  });

  it("cancelling says so when no full sync is running", () => {
    const { runner, notices } = setup();
    runner.cancelFullSync();
    expect(notices).toEqual(["Circleback Sync: no full sync is running."]);
  });

  it("cancelling a normal sync is not cancelling a full sync", async () => {
    const { runner, engine, notices } = setup();
    const gate = deferred();
    engine.sync.mockImplementation(async () => {
      await gate.promise;
      return run({ a: ok() });
    });
    const normal = runner.syncNow();
    await Promise.resolve();

    runner.cancelFullSync();

    expect(notices).toEqual(["Circleback Sync: no full sync is running."]);
    gate.resolve();
    await normal;
  });

  it("stops the full sync when cancelled, and says it was cancelled instead of giving a result", async () => {
    const { runner, engine, notices } = setup({ accounts: [A, B] });
    const gate = deferred();
    let signal: FullSyncSignal | null = null;
    engine.fullSync.mockImplementation(async (_onProgress, given) => {
      signal = given;
      await gate.promise;
      return run({ a: ok({ written: 1 }), b: ok({ ok: false, error: "network" }) });
    });
    const pending = runner.startFullSync();
    await Promise.resolve();
    await Promise.resolve();

    runner.cancelFullSync();
    expect(signal).toEqual({ cancelled: true, stopped: false });
    gate.resolve();
    await pending;

    // The transition notice still applies; the result notice is replaced.
    expect(notices).toEqual([
      FULL_STARTED,
      "Circleback Sync: stopping the full sync after the current meeting.",
      'Circleback Sync: "Personal" stopped syncing because there was no connection to Circleback. It will try again at the next sync.',
      "Circleback Sync: full sync cancelled.",
    ]);
    expect(runner.fullSyncProgress).toBeNull();
  });

  it("stopForUnload stops the full sync without cancelling it, and says nothing afterwards", async () => {
    const { runner, engine, notices, statusChanges } = setup();
    const gate = deferred();
    let signal: FullSyncSignal | null = null;
    let report: (done: number) => void = () => undefined;
    engine.fullSync.mockImplementation(async (onProgress, given) => {
      signal = given;
      report = onProgress;
      onProgress(1);
      await gate.promise;
      return run({ a: ok({ written: 1 }) });
    });
    const pending = runner.startFullSync();
    await Promise.resolve();
    await Promise.resolve();
    notices.length = 0;

    runner.stopForUnload();
    expect(signal).toEqual({ cancelled: false, stopped: true });
    const changesBefore = statusChanges.count;
    // Still going for a moment: the engine reports the meeting it was on, then finishes.
    report(2);
    gate.resolve();
    await pending;

    // The plugin is gone: no notice and no status refresh, but the progress does not stay behind.
    expect(notices).toEqual([]);
    expect(statusChanges.count).toBe(changesBefore);
    expect(runner.fullSyncProgress).toBeNull();
  });

  it("stopForUnload also silences a normal sync that is still going, which finishes its work", async () => {
    const { runner, engine, notices, statusChanges, device } = setup();
    const gate = deferred();
    engine.sync.mockImplementation(async () => {
      await gate.promise;
      device.update("a", { lastSuccessAt: "2026-10-27T15:00:00.000Z" });
      return run({ a: ok({ written: 2 }) }, dupes(2));
    });
    const pending = runner.syncNow();
    await Promise.resolve();
    await Promise.resolve();
    const changesBefore = statusChanges.count;

    runner.stopForUnload();
    gate.resolve();
    await pending;

    // The engine's work was done; the user is not told, and the status bar is not touched.
    expect(device.account("a").lastSuccessAt).toBe("2026-10-27T15:00:00.000Z");
    expect(notices).toEqual([]);
    expect(statusChanges.count).toBe(changesBefore);
  });

  it("stopForUnload does nothing when no full sync is running", () => {
    const { runner, notices } = setup();
    expect(() => runner.stopForUnload()).not.toThrow();
    expect(notices).toEqual([]);
  });

  it("catches a thrown error, clears the progress, and tells the user", async () => {
    const { runner, engine, notices, statusChanges } = setup();
    engine.fullSync.mockImplementation(async (onProgress) => {
      onProgress(3);
      throw new Error("full sync broke");
    });

    await runner.startFullSync();

    expect(notices).toEqual([FULL_STARTED, CRASHED]);
    expect(runner.fullSyncProgress).toBeNull();
    expect(statusChanges.count).toBeGreaterThan(0);
    expect(logger.dump()).toContain("full sync broke");
  });
});

describe("SyncRunner.statusText", () => {
  it("builds one part per account from settings order, device state and keys", () => {
    const { runner, device } = setup({ accounts: [A, B], withKeys: ["a"] });
    device.update("a", { lastSuccessAt: new Date().toISOString() });

    expect(runner.statusText()).toMatch(/^Circleback: Work \d{2}:\d{2}, Personal key needed on this device$/);
  });

  it("shows an account that is failing as an error", () => {
    const { runner, device } = setup();
    device.update("a", { failing: true, lastError: "auth" });
    expect(runner.statusText()).toBe("Circleback: Work error");
  });

  it("says sync is off when it is off on this device and there is an account", () => {
    const { runner, device } = setup();
    device.syncOnThisDevice = false;
    expect(runner.statusText()).toBe(SYNC_OFF_TEXT);
  });

  it("keeps showing full sync progress when sync on this device is switched off mid-run", async () => {
    const { runner, engine, device } = setup();
    const midRun: string[] = [];
    engine.fullSync.mockImplementation(async (onProgress) => {
      onProgress(4);
      device.syncOnThisDevice = false;
      midRun.push(runner.statusText());
      return run({ a: ok() });
    });

    await runner.startFullSync();

    expect(midRun).toEqual(["Circleback: full sync 4"]);
    // Once the full sync is over, the status bar says sync is off.
    expect(runner.statusText()).toBe(SYNC_OFF_TEXT);
  });

  it("is empty with no accounts, even when sync is off", () => {
    const { runner, device } = setup({ accounts: [] });
    expect(runner.statusText()).toBe("");
    device.syncOnThisDevice = false;
    expect(runner.statusText()).toBe("");
  });
});
