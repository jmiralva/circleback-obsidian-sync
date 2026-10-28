import { DEFAULT_SETTINGS } from "../../src/settings/types";
import type { CirclebackSyncSettings } from "../../src/settings/types";
import {
  OUTPUT_SETTINGS,
  PLACEMENT_SETTINGS,
  changedOutputSettings,
  changedPlacementSettings,
} from "../../src/ui/outputSettings";

// A different value of the same kind, whatever the setting is.
function changed(value: unknown): unknown {
  if (typeof value === "boolean") return !value;
  if (typeof value === "number") return value + 1;
  return `${String(value)}x`;
}

function withChange(key: keyof CirclebackSyncSettings): CirclebackSyncSettings {
  return { ...DEFAULT_SETTINGS, [key]: changed(DEFAULT_SETTINGS[key]) };
}

describe("OUTPUT_SETTINGS", () => {
  it("names the settings that change what is written to existing notes", () => {
    expect(OUTPUT_SETTINGS).toEqual([
      "syncNotes",
      "syncTranscripts",
      "includePrivateNotes",
      "includeActionItems",
      "includeInsights",
      "saveAs",
      "linkFromDailyNotes",
      "transcriptHandling",
      "selfLabel",
    ]);
  });
});

describe("PLACEMENT_SETTINGS", () => {
  it("names the settings that decide where new notes and transcripts go", () => {
    expect(PLACEMENT_SETTINGS).toEqual([
      "baseFolderType",
      "customBaseFolder",
      "subfolderPattern",
      "customSubfolderPattern",
      "filenamePattern",
      "customTranscriptBaseFolder",
      "transcriptSubfolderPattern",
      "customTranscriptSubfolderPattern",
      "transcriptFilenamePattern",
    ]);
  });

  it("shares no setting with OUTPUT_SETTINGS, so every setting is in one list, the other, or neither", () => {
    const both = OUTPUT_SETTINGS.filter((key) => PLACEMENT_SETTINGS.includes(key));
    expect(both).toEqual([]);

    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof CirclebackSyncSettings>) {
      const lists = [OUTPUT_SETTINGS, PLACEMENT_SETTINGS].filter((list) => list.includes(key));
      expect(lists.length).toBeLessThanOrEqual(1);
    }
  });

  it("only names settings that exist", () => {
    for (const key of [...OUTPUT_SETTINGS, ...PLACEMENT_SETTINGS]) {
      expect(DEFAULT_SETTINGS).toHaveProperty(key);
    }
  });
});

describe("changedOutputSettings", () => {
  it("flags output-affecting setting changes", () => {
    const next = { ...DEFAULT_SETTINGS, includeInsights: false };

    expect(changedOutputSettings(DEFAULT_SETTINGS, next)).toEqual(["includeInsights"]);
  });

  it("ignores non-output changes", () => {
    const next = { ...DEFAULT_SETTINGS, syncIntervalMinutes: 60 };

    expect(changedOutputSettings(DEFAULT_SETTINGS, next)).toEqual([]);
  });

  it("flags each output setting on its own", () => {
    for (const key of OUTPUT_SETTINGS) {
      expect(changedOutputSettings(DEFAULT_SETTINGS, withChange(key))).toEqual([key]);
    }
  });

  it("does not flag a placement setting", () => {
    for (const key of PLACEMENT_SETTINGS) {
      expect(changedOutputSettings(DEFAULT_SETTINGS, withChange(key))).toEqual([]);
    }
  });

  it("ignores every setting that is not an output setting", () => {
    const others = (Object.keys(DEFAULT_SETTINGS) as Array<keyof CirclebackSyncSettings>).filter(
      (key) => !OUTPUT_SETTINGS.includes(key) && key !== "accounts",
    );
    expect(others.length).toBeGreaterThan(0);

    for (const key of others) {
      expect(changedOutputSettings(DEFAULT_SETTINGS, withChange(key))).toEqual([]);
    }
  });

  it("flags the two settings that turn the notes or the daily note links off or on", () => {
    expect(changedOutputSettings(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, syncNotes: false })).toEqual(["syncNotes"]);
    expect(changedOutputSettings(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, linkFromDailyNotes: true })).toEqual([
      "linkFromDailyNotes",
    ]);
  });

  it("leaves the two daily note headings and creating missing daily notes out", () => {
    const next = {
      ...DEFAULT_SETTINGS,
      dailyNoteLinkHeading: "## Links",
      dailyNoteSectionHeading: "## Sections",
      createMissingDailyNotes: "never" as const,
    };

    expect(changedOutputSettings(DEFAULT_SETTINGS, next)).toEqual([]);
  });

  it("ignores edits to the account list", () => {
    const next = { ...DEFAULT_SETTINGS, accounts: [{ id: "a", label: "Work", selfNameOverride: "Jo" }] };

    expect(changedOutputSettings(DEFAULT_SETTINGS, next)).toEqual([]);
  });

  it("lists several changes in the order of OUTPUT_SETTINGS, not the order they were made", () => {
    const next = {
      ...DEFAULT_SETTINGS,
      selfLabel: "name" as const,
      syncTranscripts: true,
      saveAs: "sections" as const,
      syncNotes: false,
    };

    expect(changedOutputSettings(DEFAULT_SETTINGS, next)).toEqual(["syncNotes", "syncTranscripts", "saveAs", "selfLabel"]);
  });

  it("returns nothing for two equal copies of the settings", () => {
    expect(changedOutputSettings(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS })).toEqual([]);
  });

  it("returns nothing when a setting was changed and then changed back", () => {
    const edited = { ...DEFAULT_SETTINGS, selfLabel: "name" as const, includeInsights: false };
    const reverted = {
      ...edited,
      selfLabel: DEFAULT_SETTINGS.selfLabel,
      includeInsights: DEFAULT_SETTINGS.includeInsights,
    };

    expect(changedOutputSettings(DEFAULT_SETTINGS, edited)).toEqual(["includeInsights", "selfLabel"]);
    expect(changedOutputSettings(DEFAULT_SETTINGS, reverted)).toEqual([]);
  });
});

describe("changedPlacementSettings", () => {
  it("flags a folder or file name change", () => {
    const next = { ...DEFAULT_SETTINGS, filenamePattern: "{date} {title}" };

    expect(changedPlacementSettings(DEFAULT_SETTINGS, next)).toEqual(["filenamePattern"]);
  });

  it("flags each placement setting on its own", () => {
    for (const key of PLACEMENT_SETTINGS) {
      expect(changedPlacementSettings(DEFAULT_SETTINGS, withChange(key))).toEqual([key]);
    }
  });

  it("does not flag an output setting", () => {
    for (const key of OUTPUT_SETTINGS) {
      expect(changedPlacementSettings(DEFAULT_SETTINGS, withChange(key))).toEqual([]);
    }
  });

  it("ignores every setting that is not a placement setting", () => {
    const others = (Object.keys(DEFAULT_SETTINGS) as Array<keyof CirclebackSyncSettings>).filter(
      (key) => !PLACEMENT_SETTINGS.includes(key) && key !== "accounts",
    );
    expect(others.length).toBeGreaterThan(0);

    for (const key of others) {
      expect(changedPlacementSettings(DEFAULT_SETTINGS, withChange(key))).toEqual([]);
    }
  });

  it("ignores edits to the account list", () => {
    const next = { ...DEFAULT_SETTINGS, accounts: [{ id: "a", label: "Work", selfNameOverride: "Jo" }] };

    expect(changedPlacementSettings(DEFAULT_SETTINGS, next)).toEqual([]);
  });

  it("lists several changes in the order of PLACEMENT_SETTINGS, not the order they were made", () => {
    const next = {
      ...DEFAULT_SETTINGS,
      transcriptFilenamePattern: "t",
      filenamePattern: "n",
      customBaseFolder: "Work",
    };

    expect(changedPlacementSettings(DEFAULT_SETTINGS, next)).toEqual([
      "customBaseFolder",
      "filenamePattern",
      "transcriptFilenamePattern",
    ]);
  });

  it("returns nothing for two equal copies, or when a setting was changed and changed back", () => {
    const edited = { ...DEFAULT_SETTINGS, filenamePattern: "{date} {title}" };
    const reverted = { ...edited, filenamePattern: DEFAULT_SETTINGS.filenamePattern };

    expect(changedPlacementSettings(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS })).toEqual([]);
    expect(changedPlacementSettings(DEFAULT_SETTINGS, edited)).toEqual(["filenamePattern"]);
    expect(changedPlacementSettings(DEFAULT_SETTINGS, reverted)).toEqual([]);
  });
});
