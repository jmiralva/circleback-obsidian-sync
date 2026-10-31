import type { TFile } from "obsidian";
import { TFile as MockTFile } from "../__mocks__/obsidian";
import { logger } from "../../src/util/logger";
import { MeetingIndex } from "../../src/vault/meetingIndex";
import { createFakeApp, type FakeApp } from "../harness/fakeApp";
import { fileText, pluginFile } from "./meetingFile";

function file(app: FakeApp, path: string): TFile {
  const found = app.vault.getFileByPath(path);
  if (!found) throw new Error(`No such file: ${path}`);
  return found;
}

/** A file object the index has never seen (the type says Obsidian's TFile; the instance is the mock's). */
function stranger(path: string): TFile {
  return new MockTFile(path) as unknown as TFile;
}

function paths(files: TFile[]): string[] {
  return files.map((f) => f.path);
}

async function built(app: FakeApp, folders: string[] = ["Circleback"]): Promise<MeetingIndex> {
  const index = new MeetingIndex(app, () => folders);
  await index.build();
  return index;
}

describe("MeetingIndex", () => {
  it("finds a note moved and renamed inside the configured folders by id and kind", async () => {
    const app = createFakeApp({
      files: { "Circleback/Standup.md": pluginFile({ id: "m1" }) },
    });
    const note = file(app, "Circleback/Standup.md");
    await app.vault.createFolder("Circleback/2026/Projects");
    await app.fileManager.renameFile(note, "Circleback/2026/Projects/Weekly sync.md");

    const index = await built(app);
    expect(paths(index.find("m1", "note"))).toEqual(["Circleback/2026/Projects/Weekly sync.md"]);
  });

  it("no longer finds a note moved out of the configured folders", async () => {
    const app = createFakeApp({
      files: { "Circleback/Standup.md": pluginFile({ id: "m1" }) },
    });
    const note = file(app, "Circleback/Standup.md");
    await app.vault.createFolder("Projects/Elsewhere");
    await app.fileManager.renameFile(note, "Projects/Elsewhere/Weekly sync.md");
    expect(app.metadataCache.getFileCache(note)?.frontmatter).toMatchObject({ circleback_id: "m1" });

    const index = await built(app);
    expect(index.find("m1", "note")).toEqual([]);
    expect(index.frontmatter(note)).toBeNull();
    expect(index.keys()).toEqual([]);
  });

  it("does not confuse a note and its transcript", async () => {
    const app = createFakeApp({
      files: {
        "Circleback/Standup.md": pluginFile({ id: "m1", kind: "note" }),
        "Circleback/Transcripts/Standup-transcript.md": pluginFile({ id: "m1", kind: "transcript" }),
      },
    });
    const index = await built(app);
    expect(paths(index.find("m1", "note"))).toEqual(["Circleback/Standup.md"]);
    expect(paths(index.find("m1", "transcript"))).toEqual(["Circleback/Transcripts/Standup-transcript.md"]);
    expect(index.find("m1", "combined")).toEqual([]);
  });

  it("reads unindexed files in configured folders", async () => {
    const app = createFakeApp({
      files: { "Circleback/New.md": pluginFile({ id: "m2" }) },
      unindexed: ["Circleback/New.md"],
    });
    expect(app.metadataCache.getFileCache(file(app, "Circleback/New.md"))).toBeNull();

    const index = await built(app);
    expect(paths(index.find("m2", "note"))).toEqual(["Circleback/New.md"]);
    expect(index.frontmatter(file(app, "Circleback/New.md"))).toMatchObject({ circleback_id: "m2" });
  });

  it("orders matches by circleback_first_synced, then path length, then path", async () => {
    const app = createFakeApp({
      files: {
        "Circleback/c.md": pluginFile({ firstSynced: "2026-10-22T08:00:00.000Z" }),
        "Circleback/b.md": pluginFile({ firstSynced: "2026-10-21T08:00:00.000Z" }),
        "Circleback/z.md": pluginFile({ firstSynced: "2026-10-20T08:00:00.000Z" }),
        "Circleback/a.md": pluginFile({ firstSynced: "2026-10-21T08:00:00.000Z" }),
      },
    });
    const index = await built(app);
    expect(paths(index.find("m1", "note"))).toEqual([
      "Circleback/z.md",
      "Circleback/a.md",
      "Circleback/b.md",
      "Circleback/c.md",
    ]);
  });

  it("sorts a file with no circleback_first_synced after those that have one", async () => {
    const app = createFakeApp({
      files: {
        "Circleback/a-missing.md": pluginFile({ firstSynced: null }),
        "Circleback/b-late.md": pluginFile({ firstSynced: "2030-01-01T00:00:00.000Z" }),
        "Circleback/c-missing.md": pluginFile({ firstSynced: null }),
        "Circleback/d-early.md": pluginFile({ firstSynced: "2020-01-01T00:00:00.000Z" }),
      },
    });
    const index = await built(app);
    expect(paths(index.find("m1", "note"))).toEqual([
      "Circleback/d-early.md",
      "Circleback/b-late.md",
      "Circleback/a-missing.md",
      "Circleback/c-missing.md",
    ]);
  });

  describe("a tie in circleback_first_synced", () => {
    const SYNCED = "2026-10-20T10:00:00.000Z";

    it("puts the shorter path first, so a hand copy never comes before the original", async () => {
      const app = createFakeApp({
        files: {
          "Circleback/Standup copy.md": pluginFile({ firstSynced: SYNCED }),
          "Circleback/Standup 1.md": pluginFile({ firstSynced: SYNCED }),
          "Circleback/Standup.md": pluginFile({ firstSynced: SYNCED }),
        },
      });
      const index = await built(app);
      expect(paths(index.find("m1", "note"))).toEqual([
        "Circleback/Standup.md",
        "Circleback/Standup 1.md",
        "Circleback/Standup copy.md",
      ]);
    });

    it("does the same when no file has a first_synced", async () => {
      const app = createFakeApp({
        files: {
          "Circleback/Standup copy.md": pluginFile({ firstSynced: null }),
          "Circleback/Standup.md": pluginFile({ firstSynced: null }),
        },
      });
      const index = await built(app);
      expect(paths(index.find("m1", "note"))).toEqual(["Circleback/Standup.md", "Circleback/Standup copy.md"]);
    });

    it("orders paths of the same length by path, by code unit", async () => {
      const app = createFakeApp({
        files: {
          "Circleback/b/Standup.md": pluginFile({ firstSynced: SYNCED }),
          "Circleback/Standup 2.md": pluginFile({ firstSynced: SYNCED }),
          "Circleback/a/Standup.md": pluginFile({ firstSynced: SYNCED }),
          "Circleback/Standup 1.md": pluginFile({ firstSynced: SYNCED }),
        },
      });
      const index = await built(app);
      expect(paths(index.find("m1", "note"))).toEqual([
        "Circleback/Standup 1.md",
        "Circleback/Standup 2.md",
        "Circleback/a/Standup.md",
        "Circleback/b/Standup.md",
      ]);
    });

    it("does not decide when first_synced differs: an earlier one beats a shorter path", async () => {
      const app = createFakeApp({
        files: {
          "Circleback/Standup.md": pluginFile({ firstSynced: "2026-10-21T10:00:00.000Z" }),
          "Circleback/Standup copy.md": pluginFile({ firstSynced: "2026-10-20T10:00:00.000Z" }),
          "Circleback/S.md": pluginFile({ firstSynced: null }),
        },
      });
      const index = await built(app);
      expect(paths(index.find("m1", "note"))).toEqual([
        "Circleback/Standup copy.md",
        "Circleback/Standup.md",
        "Circleback/S.md",
      ]);
    });
  });

  it("orders paths by code unit, not by locale, so every device picks the same file", async () => {
    const app = createFakeApp({
      files: {
        "Circleback/b.md": pluginFile({ firstSynced: null }),
        "Circleback/B.md": pluginFile({ firstSynced: null }),
        "Circleback/ä.md": pluginFile({ firstSynced: null }),
        "Circleback/a.md": pluginFile({ firstSynced: null }),
      },
    });
    const index = await built(app);
    expect(paths(index.find("m1", "note"))).toEqual([
      "Circleback/B.md",
      "Circleback/a.md",
      "Circleback/b.md",
      "Circleback/ä.md",
    ]);
  });

  it("returns an empty list for an id it has never seen", async () => {
    const app = createFakeApp({ files: { "Circleback/a.md": pluginFile({ id: "m1" }) } });
    const index = await built(app);
    expect(index.find("nope", "note")).toEqual([]);
  });

  describe("which files are indexed", () => {
    it("skips notes with no circleback_id, a non-string id, an empty id, or an unknown kind", async () => {
      const base = { circleback_kind: "note" };
      const app = createFakeApp({
        files: {
          "Circleback/plain.md": "No frontmatter at all",
          "Circleback/other.md": fileText({ title: "Not ours" }, "body"),
          "Circleback/numeric-id.md": fileText({ ...base, circleback_id: 123 }, "body"),
          "Circleback/empty-id.md": fileText({ ...base, circleback_id: "" }, "body"),
          "Circleback/no-kind.md": fileText({ circleback_id: "m1" }, "body"),
          "Circleback/bad-kind.md": fileText({ circleback_id: "m1", circleback_kind: "memo" }, "body"),
          "Circleback/list-kind.md": fileText({ circleback_id: "m1", circleback_kind: ["note"] }, "body"),
          "Circleback/ok.md": pluginFile({ id: "m1" }),
        },
      });
      const index = await built(app);
      expect(paths(index.find("m1", "note"))).toEqual(["Circleback/ok.md"]);
      expect(index.find("123", "note")).toEqual([]);
      expect(index.find("", "note")).toEqual([]);
      expect(index.keys()).toEqual([{ id: "m1", kind: "note" }]);
      for (const name of ["plain", "other", "numeric-id", "empty-id", "no-kind", "bad-kind", "list-kind"]) {
        expect(index.frontmatter(file(app, `Circleback/${name}.md`))).toBeNull();
      }
    });

    it("indexes combined files under their own kind", async () => {
      const app = createFakeApp({ files: { "Circleback/c.md": pluginFile({ id: "m1", kind: "combined" }) } });
      const index = await built(app);
      expect(paths(index.find("m1", "combined"))).toEqual(["Circleback/c.md"]);
      expect(index.find("m1", "note")).toEqual([]);
    });

    it("skips a file outside the configured folders even when the metadata cache knows its frontmatter", async () => {
      const app = createFakeApp({
        files: {
          "Archive/2025/old.md": pluginFile({ id: "m1" }),
          "Circleback Archive/old.md": pluginFile({ id: "m1" }),
          "old.md": pluginFile({ id: "m1" }),
          "Circleback/kept.md": pluginFile({ id: "m1" }),
        },
      });
      const index = await built(app, ["Circleback"]);
      expect(paths(index.find("m1", "note"))).toEqual(["Circleback/kept.md"]);
      expect(index.frontmatter(file(app, "Archive/2025/old.md"))).toBeNull();
    });

    it("skips unindexed files outside the configured folders", async () => {
      const app = createFakeApp({
        files: {
          "Elsewhere/new.md": pluginFile({ id: "m1" }),
          "Circleback Archive/new.md": pluginFile({ id: "m1" }),
          "Circleback/inside.md": pluginFile({ id: "m1" }),
        },
        unindexed: ["Elsewhere/new.md", "Circleback Archive/new.md", "Circleback/inside.md"],
      });
      const index = await built(app, ["Circleback"]);
      expect(paths(index.find("m1", "note"))).toEqual(["Circleback/inside.md"]);
    });

    it("reads unindexed files in subfolders of a configured folder", async () => {
      const app = createFakeApp({
        files: { "Circleback/2026/10/deep.md": pluginFile({ id: "m1" }) },
        unindexed: ["Circleback/2026/10/deep.md"],
      });
      const index = await built(app, ["Circleback"]);
      expect(paths(index.find("m1", "note"))).toEqual(["Circleback/2026/10/deep.md"]);
    });

    it("treats an empty folder, or a slash, as the whole vault", async () => {
      for (const root of ["", "/"]) {
        const app = createFakeApp({
          files: {
            "Anywhere/at/all.md": pluginFile({ id: "m1" }),
            "top.md": pluginFile({ id: "m2" }),
            "Cached/far/away.md": pluginFile({ id: "m3" }),
          },
          unindexed: ["Anywhere/at/all.md", "top.md"],
        });
        const index = await built(app, [root]);
        expect(paths(index.find("m1", "note"))).toEqual(["Anywhere/at/all.md"]);
        expect(paths(index.find("m2", "note"))).toEqual(["top.md"]);
        expect(paths(index.find("m3", "note"))).toEqual(["Cached/far/away.md"]);
      }
    });

    it("accepts folder names with stray slashes and several folders", async () => {
      const app = createFakeApp({
        files: { "A/x.md": pluginFile({ id: "m1" }), "B/y.md": pluginFile({ id: "m2" }), "C/z.md": pluginFile({ id: "m3" }) },
        unindexed: ["A/x.md", "B/y.md", "C/z.md"],
      });
      const index = await built(app, ["/A/", "B"]);
      expect(index.keys().map((k) => k.id)).toEqual(["m1", "m2"]);
    });

    it("skips an unindexed file with broken frontmatter, and one it cannot read, but keeps the rest", async () => {
      const app = createFakeApp({
        files: {
          "Circleback/broken.md": "---\nkey: [unclosed\n---\nbody",
          "Circleback/unreadable.md": pluginFile({ id: "m9" }),
          "Circleback/fine.md": pluginFile({ id: "m1" }),
        },
        unindexed: ["Circleback/broken.md", "Circleback/unreadable.md", "Circleback/fine.md"],
      });
      const read = app.vault.read.bind(app.vault);
      jest.spyOn(app.vault, "read").mockImplementation(async (f: TFile) => {
        if (f.path === "Circleback/unreadable.md") throw new Error("disk went away");
        return read(f);
      });

      const index = await built(app);
      expect(index.keys()).toEqual([{ id: "m1", kind: "note" }]);
      expect(logger.dump()).toContain("Circleback/unreadable.md");
    });
  });

  describe("frontmatter", () => {
    it("returns the frontmatter of an indexed file, and null for any other file", async () => {
      const app = createFakeApp({
        files: {
          "Circleback/a.md": pluginFile({ id: "m1", extra: { people: ["x"] } }),
          "Circleback/other.md": fileText({ title: "Not ours" }, "body"),
        },
      });
      const index = await built(app);
      expect(index.frontmatter(file(app, "Circleback/a.md"))).toMatchObject({
        circleback_id: "m1",
        circleback_kind: "note",
        people: ["x"],
      });
      expect(index.frontmatter(file(app, "Circleback/other.md"))).toBeNull();
      expect(index.frontmatter(stranger("Circleback/never-seen.md"))).toBeNull();
    });

    it("is a snapshot from build time, not the live metadata cache", async () => {
      const app = createFakeApp({ files: { "Circleback/a.md": pluginFile({ id: "m1" }) } });
      const note = file(app, "Circleback/a.md");
      const index = await built(app);
      await app.fileManager.processFrontMatter(note, (fm) => {
        fm.circleback_updated = "2027-01-01T00:00:00.000Z";
      });
      expect(index.frontmatter(note)?.circleback_updated).toBe("2026-10-20T10:00:00.000Z");
    });
  });

  describe("build", () => {
    it("starts over each time: a deleted file disappears and a new one appears", async () => {
      const app = createFakeApp({ files: { "Circleback/a.md": pluginFile({ id: "m1" }) } });
      const index = await built(app);
      expect(index.find("m1", "note")).toHaveLength(1);

      await app.vault.delete(file(app, "Circleback/a.md"));
      await app.vault.create("Circleback/b.md", pluginFile({ id: "m2" }));
      await index.build();

      expect(index.find("m1", "note")).toEqual([]);
      expect(paths(index.find("m2", "note"))).toEqual(["Circleback/b.md"]);
    });

    it("re-reads the configured folders every time", async () => {
      const app = createFakeApp({
        files: { "Old/a.md": pluginFile({ id: "m1" }) },
        unindexed: ["Old/a.md"],
      });
      let folders = ["Elsewhere"];
      const index = new MeetingIndex(app, () => folders);
      await index.build();
      expect(index.find("m1", "note")).toEqual([]);
      folders = ["Old"];
      await index.build();
      expect(paths(index.find("m1", "note"))).toEqual(["Old/a.md"]);
    });
  });

  describe("keeping the index current during a run", () => {
    it("upsert makes a file findable before the metadata cache has indexed it", async () => {
      const app = createFakeApp({ unindexed: ["Circleback/new.md"] });
      await app.vault.createFolder("Circleback");
      const index = await built(app);
      const created = await app.vault.create("Circleback/new.md", pluginFile({ id: "m1" }));
      expect(app.metadataCache.getFileCache(created)).toBeNull();
      expect(index.find("m1", "note")).toEqual([]);

      index.upsert(created, { circleback_id: "m1", circleback_kind: "note", circleback_first_synced: "2026-10-27T00:00:00.000Z" });

      expect(index.find("m1", "note")).toEqual([created]);
      expect(index.frontmatter(created)).toMatchObject({ circleback_id: "m1" });
    });

    it("upsert replaces what the index knew about the file, even when its id or kind changes", async () => {
      const app = createFakeApp({ files: { "Circleback/a.md": pluginFile({ id: "m1", kind: "note" }) } });
      const note = file(app, "Circleback/a.md");
      const index = await built(app);

      index.upsert(note, { circleback_id: "m2", circleback_kind: "combined" });

      expect(index.find("m1", "note")).toEqual([]);
      expect(index.find("m2", "combined")).toEqual([note]);
      expect(index.keys()).toEqual([{ id: "m2", kind: "combined" }]);
    });

    it("upsert re-sorts a file whose first_synced changed", async () => {
      const app = createFakeApp({
        files: {
          "Circleback/a.md": pluginFile({ firstSynced: "2026-10-20T00:00:00.000Z" }),
          "Circleback/b.md": pluginFile({ firstSynced: "2026-10-21T00:00:00.000Z" }),
        },
      });
      const index = await built(app);
      index.upsert(file(app, "Circleback/a.md"), {
        circleback_id: "m1",
        circleback_kind: "note",
        circleback_first_synced: "2026-10-25T00:00:00.000Z",
      });
      expect(paths(index.find("m1", "note"))).toEqual(["Circleback/b.md", "Circleback/a.md"]);
    });

    it("upsert leaves out a file outside the configured folders", async () => {
      const app = createFakeApp({ files: { "Archive/a.md": pluginFile({ id: "m1" }), "Circleback/b.md": "" } });
      const index = await built(app, ["Circleback"]);
      const fm = { circleback_id: "m1", circleback_kind: "note" };

      index.upsert(file(app, "Archive/a.md"), fm);
      index.upsert(file(app, "Circleback/b.md"), fm);

      expect(paths(index.find("m1", "note"))).toEqual(["Circleback/b.md"]);
      expect(index.frontmatter(file(app, "Archive/a.md"))).toBeNull();
    });

    it("upsert drops a file whose frontmatter is not a plugin file's", async () => {
      const app = createFakeApp({ files: { "Circleback/a.md": pluginFile({ id: "m1" }) } });
      const note = file(app, "Circleback/a.md");
      const index = await built(app);
      index.upsert(note, { title: "No longer ours" });
      expect(index.find("m1", "note")).toEqual([]);
      index.upsert(note, { circleback_id: "m1", circleback_kind: "note" });
      expect(index.find("m1", "note")).toEqual([note]);
      index.upsert(note, null);
      expect(index.find("m1", "note")).toEqual([]);
      expect(index.keys()).toEqual([]);
    });

    it("forget removes a file, and does nothing for one it does not hold", async () => {
      const app = createFakeApp({
        files: { "Circleback/a.md": pluginFile({ id: "m1" }), "Circleback/b.md": pluginFile({ id: "m1", firstSynced: "2030-01-01T00:00:00.000Z" }) },
      });
      const index = await built(app);
      index.forget(file(app, "Circleback/a.md"));
      expect(paths(index.find("m1", "note"))).toEqual(["Circleback/b.md"]);
      expect(index.frontmatter(file(app, "Circleback/a.md"))).toBeNull();
      index.forget(file(app, "Circleback/a.md"));
      index.forget(stranger("Circleback/never-seen.md"));
      expect(paths(index.find("m1", "note"))).toEqual(["Circleback/b.md"]);
      index.forget(file(app, "Circleback/b.md"));
      expect(index.keys()).toEqual([]);
    });

    it("still finds a file after it is renamed, because it tracks the file and not its path", async () => {
      const app = createFakeApp({ files: { "Circleback/a.md": pluginFile({ id: "m1" }) } });
      const note = file(app, "Circleback/a.md");
      const index = await built(app);
      await app.fileManager.renameFile(note, "Circleback/renamed.md");
      expect(paths(index.find("m1", "note"))).toEqual(["Circleback/renamed.md"]);
    });
  });

  describe("keys", () => {
    it("lists each (id, kind) pair once, sorted by id then kind", async () => {
      const app = createFakeApp({
        files: {
          "Circleback/1.md": pluginFile({ id: "b", kind: "note" }),
          "Circleback/2.md": pluginFile({ id: "b", kind: "note" }),
          "Circleback/3.md": pluginFile({ id: "b", kind: "transcript" }),
          "Circleback/4.md": pluginFile({ id: "a", kind: "transcript" }),
          "Circleback/5.md": pluginFile({ id: "a", kind: "combined" }),
        },
      });
      const index = await built(app);
      expect(index.keys()).toEqual([
        { id: "a", kind: "combined" },
        { id: "a", kind: "transcript" },
        { id: "b", kind: "note" },
        { id: "b", kind: "transcript" },
      ]);
    });
  });
});
