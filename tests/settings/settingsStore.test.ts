import { Plugin } from "obsidian";
import type { PluginManifest } from "obsidian";
import { createFakeApp } from "../harness/fakeApp";
import { SettingsStore } from "../../src/settings/settingsStore";
import { DEFAULT_SETTINGS } from "../../src/settings/types";
import type { CirclebackSyncSettings } from "../../src/settings/types";

// The real Plugin class is abstract in obsidian.d.ts; the mock is concrete.
class TestPlugin extends Plugin {}

function makePlugin(): TestPlugin {
  return new TestPlugin(createFakeApp(), { id: "circleback-sync" } as PluginManifest);
}

// What another device's data.json looks like to this device.
function diskHolds(plugin: TestPlugin, data: unknown): jest.SpyInstance {
  return jest.spyOn(plugin, "loadData").mockResolvedValue(data);
}

describe("DEFAULT_SETTINGS", () => {
  it("has exactly the values the spec lists", () => {
    const expected: CirclebackSyncSettings = {
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
    expect(DEFAULT_SETTINGS).toEqual(expected);
  });
});

describe("SettingsStore.load", () => {
  it("fills missing keys from DEFAULT_SETTINGS", async () => {
    const plugin = makePlugin();
    diskHolds(plugin, {});
    const store = new SettingsStore(plugin);
    await store.load();
    expect(store.current.syncIntervalMinutes).toBe(30);
    expect(store.current).toEqual(DEFAULT_SETTINGS);
  });

  it("uses the defaults when there is no data.json yet", async () => {
    const store = new SettingsStore(makePlugin());
    const loaded = await store.load();
    expect(loaded).toEqual(DEFAULT_SETTINGS);
    expect(store.current).toBe(loaded);
  });

  it("keeps stored values over the defaults and fills in only what is missing", async () => {
    const plugin = makePlugin();
    diskHolds(plugin, { syncIntervalMinutes: 15, periodicSync: true, filenamePattern: "{date} - {title}" });
    const store = new SettingsStore(plugin);
    await store.load();
    expect(store.current.syncIntervalMinutes).toBe(15);
    expect(store.current.periodicSync).toBe(true);
    expect(store.current.filenamePattern).toBe("{date} - {title}");
    expect(store.current.settleDelayMinutes).toBe(10);
  });

  it("never shares mutable values with DEFAULT_SETTINGS", async () => {
    const store = new SettingsStore(makePlugin());
    await store.load();
    store.current.accounts.push({ id: "u1", label: "Work", selfNameOverride: "" });
    expect(DEFAULT_SETTINGS.accounts).toEqual([]);
    const other = new SettingsStore(makePlugin());
    await other.load();
    expect(other.current.accounts).toEqual([]);
  });

  it("does not share accounts with the object loadData returned", async () => {
    const plugin = makePlugin();
    const onDisk = { accounts: [{ id: "u1", label: "Work", selfNameOverride: "" }] };
    diskHolds(plugin, onDisk);
    const store = new SettingsStore(plugin);
    await store.load();
    store.current.accounts[0].label = "Changed";
    expect(onDisk.accounts[0].label).toBe("Work");
  });

  it("replaces a stored value of the wrong type with the default", async () => {
    const plugin = makePlugin();
    diskHolds(plugin, { syncIntervalMinutes: "soon", periodicSync: 1, accounts: "none", customBaseFolder: null });
    const store = new SettingsStore(plugin);
    await store.load();
    expect(store.current.syncIntervalMinutes).toBe(30);
    expect(store.current.periodicSync).toBe(false);
    expect(store.current.accounts).toEqual([]);
    expect(store.current.customBaseFolder).toBe("Circleback");
  });

  it("repairs account entries: drops those without an id, fills a missing label or override", async () => {
    const plugin = makePlugin();
    diskHolds(plugin, {
      accounts: [
        { id: "u1", label: "Work", selfNameOverride: "Jorge" },
        { id: "u2" },
        { label: "No id" },
        { id: "" },
        "junk",
        null,
      ],
    });
    const store = new SettingsStore(plugin);
    await store.load();
    expect(store.current.accounts).toEqual([
      { id: "u1", label: "Work", selfNameOverride: "Jorge" },
      { id: "u2", label: "", selfNameOverride: "" },
    ]);
  });

  it("treats a data.json that is not an object as empty", async () => {
    for (const bad of ["text", 42, [1, 2], true]) {
      const plugin = makePlugin();
      diskHolds(plugin, bad);
      const store = new SettingsStore(plugin);
      await store.load();
      expect(store.current).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("keeps keys it does not know, so an older version does not erase a newer one's settings", async () => {
    const plugin = makePlugin();
    diskHolds(plugin, { fromTheFuture: { a: 1 } });
    const store = new SettingsStore(plugin);
    await store.load();
    await store.save(store.current);
    expect(await plugin.loadData()).toMatchObject({ fromTheFuture: { a: 1 } });
  });

  it("never writes data.json", async () => {
    const plugin = makePlugin();
    const saveData = jest.spyOn(plugin, "saveData");
    const store = new SettingsStore(plugin);
    await store.load();
    await store.reloadFromDisk();
    expect(saveData).not.toHaveBeenCalled();
  });

  it("has usable defaults before load is called", () => {
    const store = new SettingsStore(makePlugin());
    expect(store.current).toEqual(DEFAULT_SETTINGS);
    expect(store.current).not.toBe(DEFAULT_SETTINGS);
  });
});

describe("SettingsStore.save", () => {
  it("writes data.json and updates current", async () => {
    const plugin = makePlugin();
    const store = new SettingsStore(plugin);
    await store.load();
    await store.save({ ...store.current, syncDaysBack: 14, includeShared: true });
    expect(store.current.syncDaysBack).toBe(14);
    expect(await plugin.loadData()).toMatchObject({ syncDaysBack: 14, includeShared: true });
  });

  it("round-trips through a fresh store", async () => {
    const plugin = makePlugin();
    const first = new SettingsStore(plugin);
    await first.load();
    const account = { id: "u1", label: "Work", selfNameOverride: "" };
    await first.save({ ...first.current, accounts: [account], titleFilterMode: "exclude", titleFilterKeyword: "1:1" });
    const second = new SettingsStore(plugin);
    await second.load();
    expect(second.current).toEqual(first.current);
    expect(second.current.accounts).toEqual([account]);
  });

  it("keeps its own copy, so later edits to the object passed in do not leak in", async () => {
    const store = new SettingsStore(makePlugin());
    await store.load();
    const next = { ...store.current, accounts: [{ id: "u1", label: "Work", selfNameOverride: "" }] };
    await store.save(next);
    next.accounts[0].label = "Changed";
    expect(store.current.accounts[0].label).toBe("Work");
  });

  it("tells subscribers about the new settings, after the write", async () => {
    const plugin = makePlugin();
    const store = new SettingsStore(plugin);
    await store.load();
    // What data.json held at the moment the subscriber was called.
    let diskAtNotify: Promise<unknown> | undefined;
    const callback = jest.fn((_settings: CirclebackSyncSettings) => {
      diskAtNotify = plugin.loadData();
    });
    store.onChange(callback);
    await store.save({ ...store.current, syncDaysBack: 3 });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0].syncDaysBack).toBe(3);
    expect(await diskAtNotify).toMatchObject({ syncDaysBack: 3 });
  });

  it("changes nothing and tells nobody when the write fails", async () => {
    const plugin = makePlugin();
    const store = new SettingsStore(plugin);
    await store.load();
    const callback = jest.fn();
    store.onChange(callback);
    jest.spyOn(plugin, "saveData").mockRejectedValue(new Error("disk full"));
    await expect(store.save({ ...store.current, syncDaysBack: 99 })).rejects.toThrow("disk full");
    expect(store.current.syncDaysBack).toBe(7);
    expect(callback).not.toHaveBeenCalled();
  });

  it("lets every subscriber run even when one throws, and still resolves", async () => {
    const store = new SettingsStore(makePlugin());
    await store.load();
    const after = jest.fn();
    store.onChange(() => {
      throw new Error("bad subscriber");
    });
    store.onChange(after);
    await expect(store.save({ ...store.current, syncDaysBack: 2 })).resolves.toBeUndefined();
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsStore.reloadFromDisk", () => {
  it("picks up another device's edit", async () => {
    const plugin = makePlugin();
    const store = new SettingsStore(plugin);
    await store.load();
    expect(store.current.accounts).toHaveLength(0);
    diskHolds(plugin, { accounts: [{ id: "u1", label: "Work", selfNameOverride: "" }], syncDaysBack: 30 });
    const reloaded = await store.reloadFromDisk();
    expect(store.current.accounts).toHaveLength(1);
    expect(store.current.syncDaysBack).toBe(30);
    expect(reloaded).toBe(store.current);
  });

  it("drops local values the other device no longer has, back to the defaults", async () => {
    const plugin = makePlugin();
    const store = new SettingsStore(plugin);
    await store.load();
    await store.save({ ...store.current, syncDaysBack: 30 });
    diskHolds(plugin, {});
    await store.reloadFromDisk();
    expect(store.current.syncDaysBack).toBe(7);
  });

  it("tells subscribers", async () => {
    const plugin = makePlugin();
    const store = new SettingsStore(plugin);
    await store.load();
    const callback = jest.fn();
    store.onChange(callback);
    diskHolds(plugin, { syncDaysBack: 30 });
    await store.reloadFromDisk();
    expect(callback).toHaveBeenCalledTimes(1);
    expect((callback.mock.calls[0] as [CirclebackSyncSettings])[0].syncDaysBack).toBe(30);
  });

  it("does not tell subscribers on the first load", async () => {
    const store = new SettingsStore(makePlugin());
    const callback = jest.fn();
    store.onChange(callback);
    await store.load();
    expect(callback).not.toHaveBeenCalled();
  });
});
