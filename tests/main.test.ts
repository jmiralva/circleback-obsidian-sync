import type { PluginManifest } from "obsidian";
import CirclebackSyncPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings/types";
import { logger } from "../src/util/logger";
import { Plugin as MockPlugin } from "./__mocks__/obsidian";
import { createFakeApp, type FakeApp } from "./harness/fakeApp";

const MANIFEST = { id: "circleback-sync" } as PluginManifest;
const MIN = 60_000;

// Periodic sync on, with a one minute settle delay so tests do not have to wait ten.
const PERIODIC = {
  ...DEFAULT_SETTINGS,
  periodicSync: true,
  settleDelayMinutes: 1,
  accounts: [{ id: "a", label: "Work", selfNameOverride: "" }],
};

interface Loaded {
  app: FakeApp;
  plugin: CirclebackSyncPlugin;
  /** What the plugin registered, as the mock Plugin recorded it. */
  recorded: MockPlugin;
}

async function load(
  opts: { layoutReady?: boolean; data?: unknown } = {},
): Promise<Loaded> {
  const app = createFakeApp({ layoutReady: opts.layoutReady });
  const plugin = new CirclebackSyncPlugin(app, MANIFEST);
  if (opts.data !== undefined) await plugin.saveData(opts.data);
  await plugin.onload();
  return { app, plugin, recorded: plugin as unknown as MockPlugin };
}

beforeAll(() => {
  // main.ts uses window.setTimeout; in jest's node environment the window is the global object.
  Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "window");
});

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  logger.setDebug(false);
});

describe("CirclebackSyncPlugin.onload", () => {
  it("registers the three commands, with no hotkeys", async () => {
    const { recorded } = await load();

    expect(recorded.commands.map((c) => ({ id: c.id, name: c.name }))).toEqual([
      { id: "sync-now", name: "Sync now" },
      { id: "full-sync", name: "Full sync" },
      { id: "cancel-full-sync", name: "Cancel full sync" },
    ]);
    for (const command of recorded.commands) expect(command).not.toHaveProperty("hotkeys");
  });

  it("runs the matching runner method from each command", async () => {
    const { plugin, recorded } = await load();
    const syncNow = jest.spyOn(plugin.runner, "syncNow").mockResolvedValue();
    const startFullSync = jest.spyOn(plugin.runner, "startFullSync").mockResolvedValue();
    const cancelFullSync = jest.spyOn(plugin.runner, "cancelFullSync").mockReturnValue();
    const run = (id: string): void => {
      const command = recorded.commands.find((c) => c.id === id);
      (command?.callback as () => void)();
    };

    run("sync-now");
    run("full-sync");
    run("cancel-full-sync");

    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(startFullSync).toHaveBeenCalledTimes(1);
    expect(cancelFullSync).toHaveBeenCalledTimes(1);
  });

  it("adds one status bar item, hidden with no accounts", async () => {
    const { recorded } = await load();

    expect(recorded.statusBarItems).toHaveLength(1);
    expect(recorded.statusBarItems[0]).toMatchObject({ hidden: true, text: "" });
  });

  it("shows the status of the accounts in the status bar", async () => {
    const { recorded, plugin } = await load({
      data: { ...DEFAULT_SETTINGS, accounts: [{ id: "a", label: "Work", selfNameOverride: "" }] },
    });

    // The account has no key on this device yet.
    expect(recorded.statusBarItems[0]).toMatchObject({ hidden: false, text: "Circleback: Work key needed on this device" });

    plugin.keys.set("a", "cb_key_a");
    plugin.refreshStatus();
    expect(recorded.statusBarItems[0].text).toBe("Circleback: Work not synced yet");
  });

  it("shows that sync is off on this device", async () => {
    const { recorded, plugin } = await load({
      data: { ...DEFAULT_SETTINGS, accounts: [{ id: "a", label: "Work", selfNameOverride: "" }] },
    });
    plugin.device.syncOnThisDevice = false;

    plugin.refreshStatus();

    expect(recorded.statusBarItems[0].text).toBe("Circleback: off on this device");
  });

  it("applies the debug logging setting at load and when settings change", async () => {
    const setDebug = jest.spyOn(logger, "setDebug");
    const { plugin } = await load({ data: { ...DEFAULT_SETTINGS, debugLogging: true } });
    expect(setDebug).toHaveBeenLastCalledWith(true);

    await plugin.settingsStore.save({ ...plugin.settingsStore.current, debugLogging: false });
    expect(setDebug).toHaveBeenLastCalledWith(false);
  });

  it("listens for settings changes exactly once, and refreshes the status when they happen", async () => {
    const app = createFakeApp();
    const plugin = new CirclebackSyncPlugin(app, MANIFEST);
    const onChange = jest.spyOn(plugin.settingsStore, "onChange");
    await plugin.onload();
    const recorded = plugin as unknown as MockPlugin;

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(recorded.statusBarItems[0].hidden).toBe(true);
    await plugin.settingsStore.save({
      ...plugin.settingsStore.current,
      accounts: [{ id: "a", label: "Work", selfNameOverride: "" }],
    });
    expect(recorded.statusBarItems[0].hidden).toBe(false);
  });

  it("exposes what the settings tab needs", async () => {
    const { plugin } = await load();

    expect(plugin.settingsStore).toBeDefined();
    expect(plugin.keys).toBeDefined();
    expect(plugin.device).toBeDefined();
    expect(plugin.runner).toBeDefined();
    expect(typeof plugin.refreshStatus).toBe("function");
    expect(plugin.clientFor("cb_key_a")).toBeDefined();
  });

  it("starts the scheduler only after the layout is ready and the cache has resolved", async () => {
    const { app, plugin } = await load({ layoutReady: false, data: PERIODIC });
    const scheduled = jest.spyOn(plugin.runner, "syncScheduled").mockResolvedValue();

    await jest.advanceTimersByTimeAsync(10 * MIN);
    expect(scheduled).not.toHaveBeenCalled();

    app.workspace.fireLayoutReady();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(scheduled).not.toHaveBeenCalled();

    // The settle delay is one minute in these settings, and it counts from here.
    app.metadataCache.fireResolved();
    await jest.advanceTimersByTimeAsync(MIN - 1);
    expect(scheduled).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(scheduled).toHaveBeenCalledTimes(1);
  });

  it("does not miss the cache's first resolved event while the settings are loading", async () => {
    const app = createFakeApp({ layoutReady: false });
    const plugin = new CirclebackSyncPlugin(app, MANIFEST);
    // Obsidian finishes indexing while data.json is being read.
    jest.spyOn(plugin, "loadData").mockImplementation(async () => {
      app.metadataCache.fireResolved();
      return PERIODIC;
    });
    await plugin.onload();
    const scheduled = jest.spyOn(plugin.runner, "syncScheduled").mockResolvedValue();

    // The layout is the last thing to be ready. With `resolved` already seen, the scheduler starts
    // now; had it been missed, the 60 second fallback would delay it.
    app.workspace.fireLayoutReady();
    await jest.advanceTimersByTimeAsync(MIN - 1);
    expect(scheduled).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(scheduled).toHaveBeenCalledTimes(1);
  });

  it("starts the scheduler at once when the plugin is enabled after startup", async () => {
    const { plugin } = await load({ layoutReady: true, data: PERIODIC });
    const scheduled = jest.spyOn(plugin.runner, "syncScheduled").mockResolvedValue();

    await jest.advanceTimersByTimeAsync(MIN);

    expect(scheduled).toHaveBeenCalledTimes(1);
  });

  it("does not run automatic syncs while periodic sync is off or this device does not sync", async () => {
    const off = await load({ data: { ...PERIODIC, periodicSync: false } });
    const offRun = jest.spyOn(off.plugin.runner, "syncScheduled").mockResolvedValue();
    const paused = await load({ data: PERIODIC });
    paused.plugin.device.syncOnThisDevice = false;
    const pausedRun = jest.spyOn(paused.plugin.runner, "syncScheduled").mockResolvedValue();

    await jest.advanceTimersByTimeAsync(10 * MIN);

    expect(offRun).not.toHaveBeenCalled();
    expect(pausedRun).not.toHaveBeenCalled();
  });

  it("on unload stops the scheduler, stops a running full sync, and never starts the scheduler later", async () => {
    const { app, plugin, recorded } = await load({ layoutReady: false, data: PERIODIC });
    const scheduled = jest.spyOn(plugin.runner, "syncScheduled").mockResolvedValue();
    const stopForUnload = jest.spyOn(plugin.runner, "stopForUnload");

    for (const cleanup of recorded.cleanups) cleanup();
    expect(stopForUnload).toHaveBeenCalledTimes(1);

    // Obsidian finishes loading after the plugin was unloaded.
    app.workspace.fireLayoutReady();
    app.metadataCache.fireResolved();
    await jest.advanceTimersByTimeAsync(10 * MIN);
    expect(scheduled).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("stops the checks it started when the plugin unloads", async () => {
    const { plugin, recorded } = await load({ layoutReady: true, data: PERIODIC });
    const scheduled = jest.spyOn(plugin.runner, "syncScheduled").mockResolvedValue();
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(1);

    for (const cleanup of recorded.cleanups) cleanup();

    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10 * MIN);
    expect(scheduled).not.toHaveBeenCalled();
  });
});

describe("CirclebackSyncPlugin.onExternalSettingsChange", () => {
  it("reloads the settings from disk", async () => {
    const { plugin } = await load();
    const reload = jest.spyOn(plugin.settingsStore, "reloadFromDisk");

    await plugin.onExternalSettingsChange();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("picks up what another device saved and refreshes the status", async () => {
    const { plugin, recorded } = await load();
    expect(recorded.statusBarItems[0].hidden).toBe(true);

    await plugin.saveData({ ...DEFAULT_SETTINGS, accounts: [{ id: "a", label: "Work", selfNameOverride: "" }] });
    await plugin.onExternalSettingsChange();

    expect(plugin.settingsStore.current.accounts).toHaveLength(1);
    expect(recorded.statusBarItems[0].hidden).toBe(false);
  });
});
