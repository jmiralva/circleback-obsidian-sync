import { DEFAULT_SETTINGS } from "../../src/settings/types";
import type { CirclebackSyncSettings } from "../../src/settings/types";
import { SettingsSaver, type Edit } from "../../src/ui/settingsSaver";
import { withField } from "../../src/ui/settingsEdits";
import { debounce } from "../__mocks__/obsidian";

const DELAY = 500;

// The few parts of SettingsStore the saver uses. `save` can be slow or fail, to test the queue.
class FakeStore {
  current: CirclebackSyncSettings = { ...DEFAULT_SETTINGS };
  readonly saved: CirclebackSyncSettings[] = [];
  /** How long each save takes, in ms of fake time. */
  delayMs = 0;
  /** How many of the next saves fail. */
  failNext = 0;

  async save(next: CirclebackSyncSettings): Promise<void> {
    if (this.delayMs > 0) await new Promise((done) => setTimeout(done, this.delayMs));
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("disk full");
    }
    this.current = JSON.parse(JSON.stringify(next)) as CirclebackSyncSettings;
    this.saved.push(this.current);
  }
}

function setup(): {
  store: FakeStore;
  saver: SettingsSaver;
  onSaveError: jest.Mock;
  onSettingsChanged: jest.Mock;
} {
  const store = new FakeStore();
  const onSaveError = jest.fn();
  const onSettingsChanged = jest.fn();
  const saver = new SettingsSaver({
    store,
    debounce: (callback) => debounce(callback, DELAY, true),
    onSaveError,
    onSettingsChanged,
  });
  return { store, saver, onSaveError, onSettingsChanged };
}

function set<K extends keyof CirclebackSyncSettings>(key: K, value: CirclebackSyncSettings[K]): Edit {
  return (settings) => withField(settings, key, value);
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("saving text edits", () => {
  it("waits until typing has paused for 500 ms", async () => {
    const { store, saver } = setup();

    saver.later(set("filenamePattern", "{date}"));
    await jest.advanceTimersByTimeAsync(DELAY - 1);
    expect(store.saved).toHaveLength(0);

    await jest.advanceTimersByTimeAsync(1);
    expect(store.saved).toHaveLength(1);
    expect(store.current.filenamePattern).toBe("{date}");
  });

  it("restarts the wait on every edit and then saves them together, once", async () => {
    const { store, saver } = setup();

    saver.later(set("filenamePattern", "{d"));
    await jest.advanceTimersByTimeAsync(400);
    saver.later(set("customBaseFolder", "Work"));
    await jest.advanceTimersByTimeAsync(400);
    saver.later(set("filenamePattern", "{date}"));
    await jest.advanceTimersByTimeAsync(DELAY - 1);
    expect(store.saved).toHaveLength(0);

    await jest.advanceTimersByTimeAsync(1);

    expect(store.saved).toHaveLength(1);
    expect(store.current).toMatchObject({ filenamePattern: "{date}", customBaseFolder: "Work" });
  });

  it("applies each edit to the settings as they are when it is saved", async () => {
    const { store, saver } = setup();
    store.current = { ...DEFAULT_SETTINGS, includeInsights: false };

    saver.later(set("filenamePattern", "x"));
    await saver.flush();

    expect(store.current).toMatchObject({ filenamePattern: "x", includeInsights: false });
  });
});

describe("typing, then another change", () => {
  it("keeps both when a toggle is flipped within 500 ms of typing", async () => {
    const { store, saver } = setup();

    saver.later(set("filenamePattern", "{date} {title}"));
    await jest.advanceTimersByTimeAsync(100);
    await saver.commit(set("includeInsights", false));

    expect(store.current).toMatchObject({ filenamePattern: "{date} {title}", includeInsights: false });
    // The typed text was saved first, then the toggle: two writes, in that order.
    expect(store.saved.map((s) => [s.filenamePattern, s.includeInsights])).toEqual([
      ["{date} {title}", true],
      ["{date} {title}", false],
    ]);

    // The text edit was not left in the debounce to save a third time.
    await jest.advanceTimersByTimeAsync(2000);
    expect(store.saved).toHaveLength(2);
  });

  it("keeps both when typing starts while a toggle is still being saved", async () => {
    const { store, saver } = setup();
    store.delayMs = 100;

    const toggled = saver.commit(set("includeInsights", false));
    saver.later(set("filenamePattern", "typed"));
    await jest.advanceTimersByTimeAsync(2000);
    await toggled;

    expect(store.current).toMatchObject({ includeInsights: false, filenamePattern: "typed" });
  });

  it("applies two commits made at once one after the other, so neither is lost", async () => {
    const { store, saver } = setup();
    store.delayMs = 100;

    const first = saver.commit(set("includeInsights", false));
    const second = saver.commit(set("includePrivateNotes", true));
    await jest.advanceTimersByTimeAsync(500);
    await Promise.all([first, second]);

    expect(store.current).toMatchObject({ includeInsights: false, includePrivateNotes: true });
  });
});

describe("flush", () => {
  it("saves what is waiting and returns only when the save has finished", async () => {
    const { store, saver } = setup();
    store.delayMs = 50;

    saver.later(set("filenamePattern", "x"));
    const flushed = saver.flush();
    await jest.advanceTimersByTimeAsync(49);
    expect(store.saved).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    await flushed;

    expect(store.current.filenamePattern).toBe("x");
  });

  it("does nothing when nothing is waiting", async () => {
    const { store, saver } = setup();

    await saver.flush();

    expect(store.saved).toHaveLength(0);
  });
});

describe("closing", () => {
  it("saves the waiting text edit before it compares, and reports what changed", async () => {
    const { store, saver, onSettingsChanged } = setup();
    saver.open();

    saver.later(set("filenamePattern", "{date}"));
    await saver.close();

    expect(store.current.filenamePattern).toBe("{date}");
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
    expect(onSettingsChanged).toHaveBeenCalledWith({ output: [], placement: ["filenamePattern"] });
  });

  it("waits for a save that is still running", async () => {
    const { store, saver, onSettingsChanged } = setup();
    store.delayMs = 100;
    saver.open();
    void saver.commit(set("saveAs", "sections"));

    const closed = saver.close();
    await jest.advanceTimersByTimeAsync(100);
    await closed;

    expect(onSettingsChanged).toHaveBeenCalledWith({ output: ["saveAs"], placement: [] });
  });

  it("reports once for a whole session of edits, each kind in the order of its list", async () => {
    const { saver, onSettingsChanged } = setup();
    saver.open();

    await saver.commit(set("selfLabel", "name"));
    saver.later(set("filenamePattern", "a"));
    saver.later(set("filenamePattern", "ab"));
    await saver.commit(set("syncTranscripts", true));
    await saver.commit(set("includeInsights", false));
    await saver.close();

    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
    expect(onSettingsChanged).toHaveBeenCalledWith({
      output: ["syncTranscripts", "includeInsights", "selfLabel"],
      placement: ["filenamePattern"],
    });
  });

  it("reports a change to folders or file names on its own, with no output settings", async () => {
    const { saver, onSettingsChanged } = setup();
    saver.open();

    await saver.commit(set("baseFolderType", "daily-notes"));
    saver.later(set("customTranscriptBaseFolder", "Elsewhere"));
    await saver.close();

    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
    expect(onSettingsChanged).toHaveBeenCalledWith({
      output: [],
      placement: ["baseFolderType", "customTranscriptBaseFolder"],
    });
  });

  it("reports an output change on its own, with no placement settings", async () => {
    const { saver, onSettingsChanged } = setup();
    saver.open();

    await saver.commit(set("includePrivateNotes", true));
    await saver.close();

    expect(onSettingsChanged).toHaveBeenCalledWith({ output: ["includePrivateNotes"], placement: [] });
  });

  it("says nothing when only settings that do not shape the notes changed", async () => {
    const { saver, onSettingsChanged } = setup();
    saver.open();

    await saver.commit(set("showSyncNotifications", false));
    saver.later(set("syncIntervalMinutes", 60));
    await saver.close();

    expect(onSettingsChanged).not.toHaveBeenCalled();
  });

  it("says nothing when an edit was reverted", async () => {
    const { saver, onSettingsChanged } = setup();
    saver.open();

    await saver.commit(set("includeInsights", false));
    saver.later(set("filenamePattern", "temp"));
    await saver.flush();
    await saver.commit(set("includeInsights", true));
    saver.later(set("filenamePattern", DEFAULT_SETTINGS.filenamePattern));
    await saver.close();

    expect(onSettingsChanged).not.toHaveBeenCalled();
  });

  it("does not report the same changes again the next time", async () => {
    const { saver, onSettingsChanged } = setup();
    saver.open();
    await saver.commit(set("saveAs", "sections"));
    await saver.close();
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);

    // The tab is opened and closed again with no edits.
    saver.open();
    await saver.close();
    // And a second close with no open in between.
    await saver.close();

    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
  });

  it("starts each session from the settings as they are when it opens", async () => {
    const { saver, onSettingsChanged } = setup();
    saver.open();
    await saver.commit(set("saveAs", "sections"));
    await saver.close();

    saver.open();
    await saver.commit(set("includeInsights", false));
    await saver.close();

    expect(onSettingsChanged).toHaveBeenCalledTimes(2);
    expect(onSettingsChanged).toHaveBeenLastCalledWith({ output: ["includeInsights"], placement: [] });
  });

  it("flushes even if the tab was never opened, and reports nothing", async () => {
    const { store, saver, onSettingsChanged } = setup();
    saver.later(set("filenamePattern", "x"));

    await saver.close();

    expect(store.current.filenamePattern).toBe("x");
    expect(onSettingsChanged).not.toHaveBeenCalled();
  });

  it("logs and carries on if the notice cannot be shown", async () => {
    const { saver, onSettingsChanged } = setup();
    onSettingsChanged.mockImplementation(() => {
      throw new Error("no notice");
    });
    saver.open();
    await saver.commit(set("saveAs", "sections"));

    await expect(saver.close()).resolves.toBeUndefined();
  });
});

describe("opening", () => {
  it("is open from the first open() until close()", () => {
    const { saver } = setup();
    expect(saver.isOpen).toBe(false);

    saver.open();
    expect(saver.isOpen).toBe(true);

    void saver.close();
    expect(saver.isOpen).toBe(false);
  });

  it("does not start over when it is opened again during the same session", async () => {
    const { saver, onSettingsChanged } = setup();
    saver.open();
    await saver.commit(set("saveAs", "sections"));

    // The tab redraws itself with display(): the starting point stays where it was.
    saver.open();
    await saver.close();

    expect(onSettingsChanged).toHaveBeenCalledWith({ output: ["saveAs"], placement: [] });
  });

  it("counts a new session at each open and each close, so late results can be told apart", () => {
    const { saver } = setup();
    const start = saver.session;

    saver.open();
    const during = saver.session;
    saver.open();
    expect(saver.session).toBe(during);

    void saver.close();
    expect(during).not.toBe(start);
    expect(saver.session).not.toBe(during);
  });
});

describe("rebase", () => {
  it("makes the changes so far count as already dealt with", async () => {
    const { saver, onSettingsChanged } = setup();
    saver.open();
    await saver.commit(set("saveAs", "sections"));

    await saver.rebase();
    await saver.close();

    expect(onSettingsChanged).not.toHaveBeenCalled();
  });

  it("still reports the changes made after it", async () => {
    const { saver, onSettingsChanged } = setup();
    saver.open();
    await saver.commit(set("saveAs", "sections"));
    await saver.rebase();

    await saver.commit(set("includeInsights", false));
    await saver.close();

    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
    expect(onSettingsChanged).toHaveBeenCalledWith({ output: ["includeInsights"], placement: [] });
  });

  it("counts a text edit that is still waiting as made before it", async () => {
    const { saver, onSettingsChanged } = setup();
    saver.open();
    saver.later(set("saveAs", "sections"));

    await saver.rebase();
    await saver.close();

    expect(onSettingsChanged).not.toHaveBeenCalled();
  });

  it("does not count folder and file name changes as dealt with, since a full sync moves and renames nothing", async () => {
    const { saver, onSettingsChanged } = setup();
    saver.open();
    await saver.commit(set("saveAs", "sections"));
    saver.later(set("filenamePattern", "{date} {title}"));

    await saver.rebase();
    await saver.close();

    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
    expect(onSettingsChanged).toHaveBeenCalledWith({ output: [], placement: ["filenamePattern"] });
  });

  it("does nothing while the tab is closed", async () => {
    const { saver, onSettingsChanged } = setup();

    await saver.rebase();
    saver.open();
    await saver.close();

    expect(saver.isOpen).toBe(false);
    expect(onSettingsChanged).not.toHaveBeenCalled();
  });
});

describe("a save that fails", () => {
  it("is reported, leaves the settings as they were, and does not stop the next save", async () => {
    const { store, saver, onSaveError } = setup();
    store.failNext = 1;

    await saver.commit(set("includeInsights", false));
    expect(onSaveError).toHaveBeenCalledTimes(1);
    expect(store.current.includeInsights).toBe(true);

    await saver.commit(set("includePrivateNotes", true));

    expect(onSaveError).toHaveBeenCalledTimes(1);
    expect(store.current).toMatchObject({ includeInsights: true, includePrivateNotes: true });
  });

  it("does not stop later text edits either", async () => {
    const { store, saver, onSaveError } = setup();
    store.failNext = 1;

    saver.later(set("filenamePattern", "lost"));
    await jest.advanceTimersByTimeAsync(DELAY);
    expect(onSaveError).toHaveBeenCalledTimes(1);

    saver.later(set("filenamePattern", "kept"));
    await jest.advanceTimersByTimeAsync(DELAY);

    expect(onSaveError).toHaveBeenCalledTimes(1);
    expect(store.current.filenamePattern).toBe("kept");
  });

  it("does not stop close() from finishing", async () => {
    const { store, saver, onSaveError, onSettingsChanged } = setup();
    store.failNext = 1;
    saver.open();
    saver.later(set("saveAs", "sections"));

    await saver.close();

    expect(onSaveError).toHaveBeenCalledTimes(1);
    // Nothing was saved, so there is nothing to tell the user about.
    expect(onSettingsChanged).not.toHaveBeenCalled();
  });

  it("survives an edit that throws", async () => {
    const { store, saver, onSaveError } = setup();

    await saver.commit(() => {
      throw new Error("bad edit");
    });
    await saver.commit(set("includeInsights", false));

    expect(onSaveError).toHaveBeenCalledTimes(1);
    expect(store.current.includeInsights).toBe(false);
  });
});
