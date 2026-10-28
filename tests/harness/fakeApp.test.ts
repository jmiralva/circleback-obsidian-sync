import { Plugin, TFile, TFolder, normalizePath, parseYaml, stringifyYaml } from "obsidian";
import type { PluginManifest } from "obsidian";
import { createFakeApp } from "./fakeApp";

async function createFile(app: ReturnType<typeof createFakeApp>, path: string, text: string): Promise<TFile> {
  return app.vault.create(path, text);
}

describe("FakeApp: metadata cache", () => {
  it("parses frontmatter into getFileCache", async () => {
    const app = createFakeApp();
    const file = await createFile(app, "a.md", "---\ncircleback_id: x\n---\nbody");
    expect(app.metadataCache.getFileCache(file)?.frontmatter?.circleback_id).toBe("x");
  });

  it("returns null cache for unindexed files", async () => {
    const app = createFakeApp({ unindexed: ["b.md"] });
    const file = await createFile(app, "b.md", "---\ncircleback_id: x\n---\nbody");
    expect(app.metadataCache.getFileCache(file)).toBeNull();
  });

  it("reports no frontmatter for plain files, broken YAML, and unclosed fences", async () => {
    const app = createFakeApp({
      files: {
        "plain.md": "just text",
        "broken.md": "---\nkey: [unclosed\n---\nbody",
        "unclosed.md": "---\nkey: value\nbody",
      },
    });
    for (const path of ["plain.md", "broken.md", "unclosed.md"]) {
      const cache = app.metadataCache.getFileCache(app.vault.getFileByPath(path) as TFile);
      expect(cache).not.toBeNull();
      expect(cache?.frontmatter).toBeUndefined();
    }
  });

  it("reflects the current content on every call", async () => {
    const app = createFakeApp({ files: { "a.md": "---\nn: 1\n---\n" } });
    const file = app.vault.getFileByPath("a.md") as TFile;
    expect(app.metadataCache.getFileCache(file)?.frontmatter?.n).toBe(1);
    await app.vault.modify(file, "---\nn: 2\n---\n");
    expect(app.metadataCache.getFileCache(file)?.frontmatter?.n).toBe(2);
    await app.vault.process(file, (text) => text.replace("n: 2", "n: 3"));
    expect(app.metadataCache.getFileCache(file)?.frontmatter?.n).toBe(3);
  });

  it("keeps date-like values as strings, as Obsidian does", () => {
    const app = createFakeApp({ files: { "a.md": "---\ncreated: 2026-10-27\nwhen: 2026-10-27T10:00:00Z\n---\n" } });
    const fm = app.metadataCache.getFileCache(app.vault.getFileByPath("a.md") as TFile)?.frontmatter;
    expect(fm?.created).toBe("2026-10-27");
    expect(fm?.when).toBe("2026-10-27T10:00:00Z");
  });

  it("getFirstLinkpathDest resolves basename links", () => {
    const app = createFakeApp({ files: { "Circleback/M.md": "x" } });
    expect(app.metadataCache.getFirstLinkpathDest("M", "Daily/2026-10-27.md")?.path).toBe("Circleback/M.md");
  });

  it("getFirstLinkpathDest resolves exact paths with or without the extension and returns null for misses", () => {
    const app = createFakeApp({ files: { "Circleback/M.md": "x", "Other/M.md": "y" } });
    const from = "Daily/d.md";
    expect(app.metadataCache.getFirstLinkpathDest("Other/M", from)?.path).toBe("Other/M.md");
    expect(app.metadataCache.getFirstLinkpathDest("Other/M.md", from)?.path).toBe("Other/M.md");
    expect(app.metadataCache.getFirstLinkpathDest("Nope", from)).toBeNull();
  });

  it("getFirstLinkpathDest prefers the note closest to the source when basenames collide", () => {
    const app = createFakeApp({ files: { "A/M.md": "a", "B/M.md": "b" } });
    expect(app.metadataCache.getFirstLinkpathDest("M", "B/source.md")?.path).toBe("B/M.md");
  });

  it("fireResolved calls resolved listeners until they are removed", () => {
    const app = createFakeApp();
    const listener = jest.fn();
    const ref = app.metadataCache.on("resolved", listener);
    app.metadataCache.fireResolved();
    expect(listener).toHaveBeenCalledTimes(1);
    app.metadataCache.offref(ref);
    app.metadataCache.fireResolved();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("FakeApp: file manager", () => {
  it("processFrontMatter keeps body and other keys", async () => {
    const app = createFakeApp({ files: { "a.md": "---\nbar: 2\n---\nbody\n" } });
    const file = app.vault.getFileByPath("a.md") as TFile;
    await app.fileManager.processFrontMatter(file, (fm) => {
      fm.foo = 1;
    });
    expect(app.fileText("a.md")).toBe("---\nbar: 2\nfoo: 1\n---\nbody\n");
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    expect(fm?.bar).toBe(2);
    expect(fm?.foo).toBe(1);
  });

  it("processFrontMatter adds a block to a file without one and keeps the body byte for byte", async () => {
    const body = "line one\r\n  indented  \n\n---\nnot frontmatter\n";
    const app = createFakeApp({ files: { "a.md": body } });
    await app.fileManager.processFrontMatter(app.vault.getFileByPath("a.md") as TFile, (fm) => {
      fm.foo = "x";
    });
    expect(app.fileText("a.md")).toBe(`---\nfoo: x\n---\n${body}`);
  });

  it("processFrontMatter keeps the body of a file whose body also contains fences", async () => {
    const app = createFakeApp({ files: { "a.md": "---\nbar: 2\n---\n---\nrule above\n---\n" } });
    await app.fileManager.processFrontMatter(app.vault.getFileByPath("a.md") as TFile, (fm) => {
      fm.foo = 1;
    });
    expect(app.fileText("a.md")).toBe("---\nbar: 2\nfoo: 1\n---\n---\nrule above\n---\n");
  });

  it("processFrontMatter round-trips YAML-hostile values", async () => {
    const title = 'He said: "#1" - ok\nnext';
    const names = ["- dash first", "Name: Colon", "# hash", 'Quote "inside"'];
    const app = createFakeApp({ files: { "a.md": "body" } });
    const file = app.vault.getFileByPath("a.md") as TFile;
    await app.fileManager.processFrontMatter(file, (fm) => {
      fm.title = title;
      fm.attendees = names;
    });
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    expect(fm?.title).toBe(title);
    expect(fm?.attendees).toEqual(names);
    expect(app.fileText("a.md").endsWith("---\nbody")).toBe(true);
  });

  it("renameFile moves content", async () => {
    const app = createFakeApp({ files: { "a.md": "hello" } });
    await app.vault.createFolder("x");
    const file = app.vault.getFileByPath("a.md") as TFile;
    await app.fileManager.renameFile(file, "x/a.md");
    expect(app.exists("x/a.md")).toBe(true);
    expect(app.exists("a.md")).toBe(false);
    expect(app.fileText("x/a.md")).toBe("hello");
    expect(app.vault.getAbstractFileByPath("a.md")).toBeNull();
    // The same TFile object follows the move, as in Obsidian.
    expect(app.vault.getFileByPath("x/a.md")).toBe(file);
    expect(file.path).toBe("x/a.md");
    expect(file.name).toBe("a.md");
    expect(file.parent?.path).toBe("x");
  });

  it("renameFile updates basename and extension", async () => {
    const app = createFakeApp({ files: { "a.md": "hello" } });
    const file = app.vault.getFileByPath("a.md") as TFile;
    await app.fileManager.renameFile(file, "Better name.md");
    expect(file.basename).toBe("Better name");
    expect(file.extension).toBe("md");
  });

  it("renameFile throws when the destination exists or its folder is missing", async () => {
    const app = createFakeApp({ files: { "a.md": "1", "b.md": "2" } });
    const file = app.vault.getFileByPath("a.md") as TFile;
    await expect(app.fileManager.renameFile(file, "b.md")).rejects.toThrow();
    await expect(app.fileManager.renameFile(file, "missing/a.md")).rejects.toThrow();
    expect(app.fileText("a.md")).toBe("1");
  });

  it("trashFile moves to .trash", async () => {
    const app = createFakeApp({ files: { "Notes/a.md": "bye" } });
    const file = app.vault.getFileByPath("Notes/a.md") as TFile;
    await app.fileManager.trashFile(file);
    expect(app.exists("Notes/a.md")).toBe(false);
    expect(app.exists(".trash/a.md")).toBe(true);
    expect(app.fileText(".trash/a.md")).toBe("bye");
    expect(app.vault.getAbstractFileByPath("Notes/a.md")).toBeNull();
    expect(app.vault.getMarkdownFiles()).toEqual([]);
  });

  it("trashFile keeps earlier trashed files with the same name", async () => {
    const app = createFakeApp({ files: { "one/a.md": "first", "two/a.md": "second" } });
    await app.fileManager.trashFile(app.vault.getFileByPath("one/a.md") as TFile);
    await app.fileManager.trashFile(app.vault.getFileByPath("two/a.md") as TFile);
    const trashed = [".trash/a.md", ".trash/a 1.md"].map((p) => app.fileText(p)).sort();
    expect(trashed).toEqual(["first", "second"]);
  });
});

describe("FakeApp: vault", () => {
  it("returns TFile and TFolder instances with the usual fields", async () => {
    const app = createFakeApp({ files: { "Meetings/2026/Weekly sync.md": "x" } });
    const file = app.vault.getAbstractFileByPath("Meetings/2026/Weekly sync.md");
    expect(file).toBeInstanceOf(TFile);
    const tfile = file as TFile;
    expect(tfile.name).toBe("Weekly sync.md");
    expect(tfile.basename).toBe("Weekly sync");
    expect(tfile.extension).toBe("md");
    expect(tfile.parent).toBeInstanceOf(TFolder);
    expect(tfile.parent?.path).toBe("Meetings/2026");
    expect(app.vault.getAbstractFileByPath("Meetings")).toBeInstanceOf(TFolder);
    expect(app.vault.getAbstractFileByPath("Meetings")).not.toBeInstanceOf(TFile);
    expect(app.vault.getAbstractFileByPath("missing.md")).toBeNull();
  });

  it("create returns the file, reads back, and refuses duplicates or missing folders", async () => {
    const app = createFakeApp();
    const file = await app.vault.create("a.md", "one");
    expect(file).toBeInstanceOf(TFile);
    expect(await app.vault.read(file)).toBe("one");
    await expect(app.vault.create("a.md", "two")).rejects.toThrow();
    await expect(app.vault.create("nope/b.md", "x")).rejects.toThrow();
    expect(app.fileText("a.md")).toBe("one");
    expect(app.exists("nope/b.md")).toBe(false);
  });

  it("createFolder creates missing parents and throws when the folder exists", async () => {
    const app = createFakeApp();
    const folder = await app.vault.createFolder("a/b/c");
    expect(folder).toBeInstanceOf(TFolder);
    expect(app.vault.getAbstractFileByPath("a/b")).toBeInstanceOf(TFolder);
    expect(app.vault.getFolderByPath("a/b/c")).toBe(folder);
    expect(app.vault.getFolderByPath("a/b/c/n.md")).toBeNull();
    await expect(app.vault.createFolder("a/b")).rejects.toThrow();
    const file = await app.vault.create("a/b/c/n.md", "x");
    expect(file.parent).toBe(folder);
  });

  it("creates the folders for initial files implicitly", () => {
    const app = createFakeApp({ files: { "Deep/er/note.md": "x", ".obsidian/daily-notes.json": "{}" } });
    expect(app.vault.getAbstractFileByPath("Deep/er")).toBeInstanceOf(TFolder);
    expect(app.exists("Deep/er")).toBe(true);
    expect(app.exists(".obsidian")).toBe(true);
  });

  it("getMarkdownFiles skips non-markdown files, the config folder, and .trash", () => {
    const app = createFakeApp({
      files: {
        "a.md": "1",
        "folder/b.md": "2",
        "image.png": "binary",
        ".obsidian/plugins/x/readme.md": "config",
        ".trash/old.md": "trashed",
      },
    });
    expect(app.vault.configDir).toBe(".obsidian");
    expect(app.vault.getMarkdownFiles().map((f) => f.path).sort()).toEqual(["a.md", "folder/b.md"]);
    expect(app.vault.getFiles().map((f) => f.path).sort()).toEqual(["a.md", "folder/b.md", "image.png"]);
  });

  it("adapter reads and checks any path, including non-markdown and config files", async () => {
    const app = createFakeApp({ files: { ".obsidian/daily-notes.json": '{"folder":"daily"}', "a.md": "x" } });
    const { adapter, configDir } = app.vault;
    expect(await adapter.exists(`${configDir}/daily-notes.json`)).toBe(true);
    expect(await adapter.read(`${configDir}/daily-notes.json`)).toBe('{"folder":"daily"}');
    expect(await adapter.exists("a.md")).toBe(true);
    expect(await adapter.exists("missing.json")).toBe(false);
    await expect(adapter.read("missing.json")).rejects.toThrow();
  });

  it("modify, process, and delete change what read returns", async () => {
    const app = createFakeApp({ files: { "a.md": "one" } });
    const file = app.vault.getFileByPath("a.md") as TFile;
    await app.vault.modify(file, "two");
    expect(await app.vault.read(file)).toBe("two");
    expect(await app.vault.cachedRead(file)).toBe("two");
    expect(await app.vault.process(file, (text) => `${text}!`)).toBe("two!");
    expect(app.fileText("a.md")).toBe("two!");
    await app.vault.delete(file);
    expect(app.exists("a.md")).toBe(false);
    expect(app.vault.getAbstractFileByPath("a.md")).toBeNull();
  });
});

describe("FakeApp: app services", () => {
  it("secretStorage returns the stored string or null", () => {
    const app = createFakeApp();
    expect(app.secretStorage.getSecret("circleback-sync-abc")).toBeNull();
    app.secretStorage.setSecret("circleback-sync-abc", "cb_key");
    expect(app.secretStorage.getSecret("circleback-sync-abc")).toBe("cb_key");
    expect(app.secretStorage.listSecrets()).toEqual(["circleback-sync-abc"]);
  });

  it("secretStorage rejects ids Obsidian would reject", () => {
    const app = createFakeApp();
    expect(() => app.secretStorage.setSecret("Bad_Id", "x")).toThrow();
  });

  it("local storage returns the saved value or null and clears on null", () => {
    const app = createFakeApp();
    expect(app.loadLocalStorage("k")).toBeNull();
    app.saveLocalStorage("k", { a: [1, 2] });
    expect(app.loadLocalStorage("k")).toEqual({ a: [1, 2] });
    app.saveLocalStorage("k", null);
    expect(app.loadLocalStorage("k")).toBeNull();
  });

  it("workspace.onLayoutReady runs the callback", () => {
    const app = createFakeApp();
    const ready = jest.fn();
    app.workspace.onLayoutReady(ready);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("holds onLayoutReady callbacks until the layout is fired when it starts not ready", () => {
    const app = createFakeApp({ layoutReady: false });
    const ready = jest.fn();
    expect(app.workspace.layoutReady).toBe(false);
    app.workspace.onLayoutReady(ready);
    expect(ready).not.toHaveBeenCalled();

    app.workspace.fireLayoutReady();

    expect(app.workspace.layoutReady).toBe(true);
    expect(ready).toHaveBeenCalledTimes(1);
    // Later callbacks run at once, and the first one is not run again.
    const later = jest.fn();
    app.workspace.onLayoutReady(later);
    app.workspace.fireLayoutReady();
    expect(later).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledTimes(1);
  });
});

// The real Plugin class is abstract in obsidian.d.ts; the mock is concrete.
class TestPlugin extends Plugin {}

describe("obsidian mock", () => {
  it("Plugin keeps app and manifest, and loadData/saveData round-trip", async () => {
    const app = createFakeApp();
    const manifest = { id: "circleback-sync" } as PluginManifest;
    const plugin = new TestPlugin(app, manifest);
    expect(plugin.app).toBe(app);
    expect(plugin.manifest).toBe(manifest);
    expect(await plugin.loadData()).toBeNull();
    await plugin.saveData({ accounts: [{ id: "u1" }] });
    expect(await plugin.loadData()).toEqual({ accounts: [{ id: "u1" }] });
  });

  it("Plugin.loadData and saveData can be spied on", async () => {
    const plugin = new TestPlugin(createFakeApp(), { id: "circleback-sync" } as PluginManifest);
    jest.spyOn(plugin, "loadData").mockResolvedValue({ fromDisk: true });
    expect(await plugin.loadData()).toEqual({ fromDisk: true });
  });

  it("normalizePath follows the documented examples", () => {
    expect(normalizePath("/foo//bar/")).toBe("foo/bar");
    expect(normalizePath("foo\\bar")).toBe("foo/bar");
    expect(normalizePath("foo bar")).toBe("foo bar");
    expect(normalizePath("")).toBe("/");
  });

  it("parseYaml and stringifyYaml round-trip", () => {
    const value = { a: "x: y", b: [1, 2], c: null };
    expect(parseYaml(stringifyYaml(value))).toEqual(value);
  });
});
