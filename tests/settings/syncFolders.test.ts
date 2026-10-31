import { DEFAULT_SETTINGS, type CirclebackSyncSettings } from "../../src/settings/types";
import { isInFolders, syncFolders } from "../../src/settings/syncFolders";

function settings(changes: Partial<CirclebackSyncSettings> = {}): CirclebackSyncSettings {
  return { ...DEFAULT_SETTINGS, ...changes };
}

describe("syncFolders", () => {
  it("is the custom base folder and the transcript base folder by default", () => {
    expect(syncFolders(settings(), "Daily")).toEqual(["Circleback", "Circleback/Transcripts"]);
  });

  it("uses the daily notes folder as the base folder when notes go there", () => {
    expect(syncFolders(settings({ baseFolderType: "daily-notes" }), "Daily")).toEqual(["Daily", "Circleback/Transcripts"]);
  });

  it("leaves out the transcript base folder when transcripts have no folder of their own", () => {
    for (const transcriptHandling of ["same-location", "combined"] as const) {
      expect(syncFolders(settings({ transcriptHandling }), "Daily")).toEqual(["Circleback"]);
    }
  });

  it("adds the daily notes folder in sections mode", () => {
    expect(syncFolders(settings({ saveAs: "sections", transcriptHandling: "same-location" }), "Daily")).toEqual([
      "Circleback",
      "Daily",
    ]);
  });

  it("keeps the vault root as it is spelled", () => {
    expect(syncFolders(settings({ customBaseFolder: "" }), "")).toEqual(["", "Circleback/Transcripts"]);
  });
});

describe("isInFolders", () => {
  it("is true for a path in a folder or any folder under it, and for the folder itself", () => {
    expect(isInFolders("Circleback/Standup.md", ["Circleback"])).toBe(true);
    expect(isInFolders("Circleback/2026/10/Standup.md", ["Circleback"])).toBe(true);
    expect(isInFolders("Circleback", ["Circleback"])).toBe(true);
    expect(isInFolders("Notes/x.md", ["Circleback", "Notes"])).toBe(true);
  });

  it("is false for a path outside every folder, including one whose name only starts the same", () => {
    expect(isInFolders("Archive/Standup.md", ["Circleback"])).toBe(false);
    expect(isInFolders("Circleback Archive/Standup.md", ["Circleback"])).toBe(false);
    expect(isInFolders("Circleback.md", ["Circleback"])).toBe(false);
    expect(isInFolders("Standup.md", [])).toBe(false);
  });

  it("treats / and an empty folder, as the settings spell the vault root, as the whole vault", () => {
    for (const root of ["/", ""]) {
      expect(isInFolders("Standup.md", [root])).toBe(true);
      expect(isInFolders("Anywhere/at/all.md", ["Circleback", root])).toBe(true);
    }
  });

  it("does not mind stray slashes in the folders or the path", () => {
    expect(isInFolders("Circleback/Standup.md", ["/Circleback/"])).toBe(true);
    expect(isInFolders("/Circleback/", ["Circleback"])).toBe(true);
    expect(isInFolders("Circleback Archive", ["/Circleback/"])).toBe(false);
    expect(isInFolders("", ["Circleback"])).toBe(false);
  });
});
