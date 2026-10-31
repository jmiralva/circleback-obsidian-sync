import { TFile } from "obsidian";
import { logger } from "../../src/util/logger";
import { canTrash, cleanUpDuplicates, findDuplicates } from "../../src/vault/duplicates";
import { MeetingIndex } from "../../src/vault/meetingIndex";
import { createFakeApp, type FakeApp } from "../harness/fakeApp";
import { fileText, pluginFile } from "./meetingFile";

const BODY = "# Meeting\n\nNotes.\n";

function file(app: FakeApp, path: string): TFile {
  const found = app.vault.getFileByPath(path);
  if (!found) throw new Error(`No such file: ${path}`);
  return found;
}

function paths(files: TFile[]): string[] {
  return files.map((f) => f.path);
}

async function indexOf(app: FakeApp): Promise<MeetingIndex> {
  const index = new MeetingIndex(app, () => [""]);
  await index.build();
  return index;
}

async function frontmatterOf(app: FakeApp, path: string): Promise<Record<string, unknown>> {
  const fm = app.metadataCache.getFileCache(file(app, path))?.frontmatter;
  if (!fm) throw new Error(`No frontmatter: ${path}`);
  return fm;
}

/** Two copies of one meeting: the earlier is the keeper, the later is the other. */
const KEEPER = "Circleback/a keeper.md";
const COPY = "Circleback/b copy.md";
function twoCopies(copy: string = pluginFile({ firstSynced: "2026-10-21T10:00:00.000Z" })): Record<string, string> {
  return { [KEEPER]: pluginFile({ firstSynced: "2026-10-20T10:00:00.000Z" }), [COPY]: copy };
}

describe("findDuplicates", () => {
  it("groups files that share an id and kind, keeping the earliest first_synced", async () => {
    const app = createFakeApp({
      files: {
        "Circleback/late.md": pluginFile({ id: "m1", firstSynced: "2026-10-22T00:00:00.000Z" }),
        "Circleback/early.md": pluginFile({ id: "m1", firstSynced: "2026-10-20T00:00:00.000Z" }),
        "Circleback/mid.md": pluginFile({ id: "m1", firstSynced: "2026-10-21T00:00:00.000Z" }),
      },
    });
    const groups = findDuplicates(await indexOf(app));
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("m1");
    expect(groups[0].kind).toBe("note");
    expect(groups[0].keep.path).toBe("Circleback/early.md");
    expect(paths(groups[0].others)).toEqual(["Circleback/mid.md", "Circleback/late.md"]);
  });

  it("breaks a tie between paths of the same length by path", async () => {
    const app = createFakeApp({
      files: {
        "Circleback/b.md": pluginFile({ firstSynced: "2026-10-20T00:00:00.000Z" }),
        "Circleback/a.md": pluginFile({ firstSynced: "2026-10-20T00:00:00.000Z" }),
      },
    });
    const [group] = findDuplicates(await indexOf(app));
    expect(group.keep.path).toBe("Circleback/a.md");
    expect(paths(group.others)).toEqual(["Circleback/b.md"]);
  });

  it("keeps the original over a hand copy with the same first_synced, and cleans up the copy", async () => {
    const synced = "2026-10-20T00:00:00.000Z";
    const app = createFakeApp({
      files: {
        "Circleback/Standup 1.md": pluginFile({ firstSynced: synced }),
        "Circleback/Standup copy.md": pluginFile({ firstSynced: synced }),
        "Circleback/Standup.md": pluginFile({ firstSynced: synced }),
      },
    });
    const [group] = findDuplicates(await indexOf(app));
    expect(group.keep.path).toBe("Circleback/Standup.md");
    expect(paths(group.others)).toEqual(["Circleback/Standup 1.md", "Circleback/Standup copy.md"]);

    const result = await cleanUpDuplicates(app, [group]);
    expect(result.trashed).toEqual(["Circleback/Standup 1.md", "Circleback/Standup copy.md"]);
    expect(app.exists("Circleback/Standup.md")).toBe(true);
  });

  it("leaves out a copy moved out of the sync folders after the index was built, and never trashes it", async () => {
    const app = createFakeApp({ files: twoCopies() });
    const index = new MeetingIndex(app, () => ["Circleback"]);
    await index.build();
    await app.vault.createFolder("Archive");
    await app.fileManager.renameFile(file(app, COPY), "Archive/b copy.md");
    const trashFile = jest.spyOn(app.fileManager, "trashFile");

    const groups = findDuplicates(index);
    await cleanUpDuplicates(app, groups, index);

    expect(groups).toEqual([]);
    expect(trashFile).not.toHaveBeenCalled();
    expect(app.exists("Archive/b copy.md")).toBe(true);
  });

  it("ignores meetings with one file, and a note and its transcript are not duplicates", async () => {
    const app = createFakeApp({
      files: {
        "Circleback/solo.md": pluginFile({ id: "solo" }),
        "Circleback/pair.md": pluginFile({ id: "pair", kind: "note" }),
        "Circleback/pair-transcript.md": pluginFile({ id: "pair", kind: "transcript" }),
      },
    });
    expect(findDuplicates(await indexOf(app))).toEqual([]);
  });

  it("reports note and transcript duplicates as separate groups, in a stable order", async () => {
    const app = createFakeApp({
      files: {
        "Circleback/1.md": pluginFile({ id: "b", kind: "transcript" }),
        "Circleback/2.md": pluginFile({ id: "b", kind: "transcript" }),
        "Circleback/3.md": pluginFile({ id: "b", kind: "note" }),
        "Circleback/4.md": pluginFile({ id: "b", kind: "note" }),
        "Circleback/5.md": pluginFile({ id: "a", kind: "note" }),
        "Circleback/6.md": pluginFile({ id: "a", kind: "note" }),
      },
    });
    const groups = findDuplicates(await indexOf(app));
    expect(groups.map((g) => `${g.id}/${g.kind}`)).toEqual(["a/note", "b/note", "b/transcript"]);
  });

  it("finds duplicates in different folders, including one the cache has not indexed", async () => {
    const app = createFakeApp({
      files: {
        "Circleback/a.md": pluginFile({ firstSynced: "2026-10-20T00:00:00.000Z" }),
        "Circleback/2026/b.md": pluginFile({ firstSynced: "2026-10-21T00:00:00.000Z" }),
      },
      unindexed: ["Circleback/2026/b.md"],
    });
    const index = new MeetingIndex(app, () => ["Circleback"]);
    await index.build();
    const [group] = findDuplicates(index);
    expect(group.keep.path).toBe("Circleback/a.md");
    expect(paths(group.others)).toEqual(["Circleback/2026/b.md"]);
  });
});

describe("canTrash", () => {
  it("is true for a copy the plugin wrote and nobody touched", async () => {
    const app = createFakeApp({ files: { "n.md": pluginFile({ body: BODY }) } });
    expect(await canTrash(app, file(app, "n.md"), await frontmatterOf(app, "n.md"))).toBe(true);
  });

  it("allows type, which the plugin sets at creation", async () => {
    const app = createFakeApp({ files: { "n.md": pluginFile({ body: BODY }) } });
    const fm = await frontmatterOf(app, "n.md");
    expect(fm.type).toBe("note");
    expect(await canTrash(app, file(app, "n.md"), fm)).toBe(true);
  });

  it("allows an empty body", async () => {
    const app = createFakeApp({ files: { "n.md": pluginFile({ body: "" }) } });
    expect(await canTrash(app, file(app, "n.md"), await frontmatterOf(app, "n.md"))).toBe(true);
  });

  it("is false when the body no longer matches the hash", async () => {
    const app = createFakeApp({
      files: {
        "edited.md": pluginFile({ body: BODY }).replace("Notes.", "Notes, plus my own thoughts."),
        "whitespace.md": pluginFile({ body: BODY }) + "\n",
      },
    });
    for (const path of ["edited.md", "whitespace.md"]) {
      expect(await canTrash(app, file(app, path), await frontmatterOf(app, path))).toBe(false);
    }
  });

  it("is false when the file has a frontmatter field the plugin does not own", async () => {
    const app = createFakeApp({ files: { "n.md": pluginFile({ body: BODY, extra: { people: ["Ada"] } }) } });
    expect(await canTrash(app, file(app, "n.md"), await frontmatterOf(app, "n.md"))).toBe(false);
  });

  it("is false when the hash is missing or not a string", async () => {
    const app = createFakeApp({
      files: {
        "none.md": fileText({ circleback_id: "m1", circleback_kind: "note" }, BODY),
        "number.md": fileText({ circleback_id: "m1", circleback_kind: "note", circleback_hash: 12345678 }, BODY),
      },
    });
    for (const path of ["none.md", "number.md"]) {
      expect(await canTrash(app, file(app, path), await frontmatterOf(app, path))).toBe(false);
    }
  });

  it("is false when the frontmatter handed in has a field the plugin does not own, whatever the file says now", async () => {
    const app = createFakeApp({ files: { "n.md": pluginFile({ body: BODY }) } });
    const fm = { ...(await frontmatterOf(app, "n.md")), people: ["Ada"] };
    expect(await canTrash(app, file(app, "n.md"), fm)).toBe(false);
  });

  it("is false when the cached frontmatter is out of date and the file has since gained a field", async () => {
    const app = createFakeApp({ files: { "n.md": pluginFile({ body: BODY }) } });
    const staleFm = await frontmatterOf(app, "n.md");
    await app.fileManager.processFrontMatter(file(app, "n.md"), (fm) => {
      fm.people = ["Ada"];
    });
    expect(await canTrash(app, file(app, "n.md"), staleFm)).toBe(false);
  });

  it("is false when the frontmatter handed in does not describe the file", async () => {
    const app = createFakeApp({ files: { "n.md": pluginFile({ body: BODY, hash: "deadbeef" }) } });
    const claimsMatch = { ...(await frontmatterOf(app, "n.md")), circleback_hash: "00000000" };
    expect(await canTrash(app, file(app, "n.md"), claimsMatch)).toBe(false);
  });

  it("is false, and logs, when the file cannot be read", async () => {
    const app = createFakeApp({ files: { "n.md": pluginFile({ body: BODY }) } });
    const fm = await frontmatterOf(app, "n.md");
    jest.spyOn(app.vault, "read").mockRejectedValue(new Error("disk went away"));
    expect(await canTrash(app, file(app, "n.md"), fm)).toBe(false);
    expect(logger.dump()).toMatch(/n\.md.*disk went away|disk went away.*n\.md/);
  });

  it("is false when the file's own frontmatter has become unreadable", async () => {
    const app = createFakeApp({ files: { "n.md": pluginFile({ body: BODY }) } });
    const fm = await frontmatterOf(app, "n.md");
    await app.vault.modify(file(app, "n.md"), "---\nkey: [unclosed\n---\n" + BODY);
    expect(await canTrash(app, file(app, "n.md"), fm)).toBe(false);
  });
});

describe("cleanUpDuplicates", () => {
  it("reports a hand-edited duplicate without trashing it", async () => {
    const app = createFakeApp({
      files: twoCopies(pluginFile({ body: BODY, firstSynced: "2026-10-21T10:00:00.000Z" }).replace("Notes.", "Notes. Mine.")),
    });
    const result = await cleanUpDuplicates(app, findDuplicates(await indexOf(app)));
    expect(result.trashed).toEqual([]);
    expect(result.reported).toEqual([KEEPER, COPY]);
    expect(app.exists(KEEPER)).toBe(true);
    expect(app.exists(COPY)).toBe(true);
  });

  it("does not trash a copy with extra user fields", async () => {
    const app = createFakeApp({
      files: twoCopies(pluginFile({ firstSynced: "2026-10-21T10:00:00.000Z", extra: { people: ["Ada", "Grace"] } })),
    });
    const result = await cleanUpDuplicates(app, findDuplicates(await indexOf(app)));
    expect(result.trashed).toEqual([]);
    expect(result.reported).toEqual([KEEPER, COPY]);
    expect(app.exists(COPY)).toBe(true);
  });

  it("trashes an untouched copy and keeps the earliest", async () => {
    const app = createFakeApp({ files: twoCopies() });
    const result = await cleanUpDuplicates(app, findDuplicates(await indexOf(app)));
    expect(result.trashed).toEqual([COPY]);
    expect(result.reported).toEqual([]);
    expect(app.exists(KEEPER)).toBe(true);
    expect(app.exists(COPY)).toBe(false);
    expect(app.exists(".trash/b copy.md")).toBe(true);
  });

  it("trashes through fileManager.trashFile, which follows the user's trash setting", async () => {
    const app = createFakeApp({ files: twoCopies() });
    const trashFile = jest.spyOn(app.fileManager, "trashFile");
    const groups = findDuplicates(await indexOf(app));
    await cleanUpDuplicates(app, groups);
    expect(trashFile).toHaveBeenCalledTimes(1);
    expect(trashFile).toHaveBeenCalledWith(groups[0].others[0]);
  });

  it("leaves four hand-split notes alone", async () => {
    const files: Record<string, string> = {};
    const names = ["Part 1", "Part 2", "Part 3", "Part 4"];
    names.forEach((name, i) => {
      // Each is a slice of the original note: the body no longer matches the hash.
      files[`Circleback/${name}.md`] = pluginFile({
        body: `${name} of the split.\n`,
        hash: "11111111",
        firstSynced: `2026-10-2${i}T10:00:00.000Z`,
      });
    });
    const app = createFakeApp({ files });
    const result = await cleanUpDuplicates(app, findDuplicates(await indexOf(app)));
    expect(result.trashed).toEqual([]);
    expect(result.reported).toEqual(names.map((name) => `Circleback/${name}.md`));
    for (const name of names) expect(app.exists(`Circleback/${name}.md`)).toBe(true);
  });

  it("never trashes the keeper, even when it is the only untouched copy among edited ones", async () => {
    const app = createFakeApp({
      files: {
        [KEEPER]: pluginFile({ firstSynced: "2026-10-20T10:00:00.000Z" }),
        "Circleback/c edited.md": pluginFile({ firstSynced: "2026-10-22T10:00:00.000Z", extra: { people: ["Ada"] } }),
      },
    });
    const result = await cleanUpDuplicates(app, findDuplicates(await indexOf(app)));
    expect(result.trashed).toEqual([]);
    expect(result.reported).toEqual([KEEPER, "Circleback/c edited.md"]);
    expect(app.exists(KEEPER)).toBe(true);
  });

  it("does not trash the keeper when the keeper itself was edited", async () => {
    const app = createFakeApp({
      files: {
        [KEEPER]: pluginFile({ firstSynced: "2026-10-20T10:00:00.000Z", extra: { people: ["Ada"] } }),
        [COPY]: pluginFile({ firstSynced: "2026-10-21T10:00:00.000Z" }),
      },
    });
    const result = await cleanUpDuplicates(app, findDuplicates(await indexOf(app)));
    expect(result.trashed).toEqual([COPY]);
    expect(result.reported).toEqual([]);
    expect(app.fileText(KEEPER)).toContain("people");
  });

  it("trashes the untouched copies of a group and reports the keeper with the copies it had to leave", async () => {
    const app = createFakeApp({
      files: {
        [KEEPER]: pluginFile({ firstSynced: "2026-10-20T10:00:00.000Z" }),
        "Circleback/b untouched.md": pluginFile({ firstSynced: "2026-10-21T10:00:00.000Z" }),
        "Circleback/c edited.md": pluginFile({ firstSynced: "2026-10-22T10:00:00.000Z", extra: { people: ["Ada"] } }),
        "Circleback/d untouched.md": pluginFile({ firstSynced: "2026-10-23T10:00:00.000Z" }),
      },
    });
    const result = await cleanUpDuplicates(app, findDuplicates(await indexOf(app)));
    expect(result.trashed).toEqual(["Circleback/b untouched.md", "Circleback/d untouched.md"]);
    expect(result.reported).toEqual([KEEPER, "Circleback/c edited.md"]);
  });

  it("handles several groups, and a note and a transcript of the same meeting separately", async () => {
    const app = createFakeApp({
      files: {
        "Circleback/n1.md": pluginFile({ id: "m1", kind: "note", firstSynced: "2026-10-20T00:00:00.000Z" }),
        "Circleback/n2.md": pluginFile({ id: "m1", kind: "note", firstSynced: "2026-10-21T00:00:00.000Z" }),
        "Circleback/t1.md": pluginFile({ id: "m1", kind: "transcript", firstSynced: "2026-10-20T00:00:00.000Z" }),
        "Circleback/t2.md": pluginFile({ id: "m1", kind: "transcript", firstSynced: "2026-10-21T00:00:00.000Z", extra: { mine: true } }),
        "Circleback/x1.md": pluginFile({ id: "m2", firstSynced: "2026-10-20T00:00:00.000Z" }),
        "Circleback/x2.md": pluginFile({ id: "m2", firstSynced: "2026-10-21T00:00:00.000Z" }),
      },
    });
    const result = await cleanUpDuplicates(app, findDuplicates(await indexOf(app)));
    expect(result.trashed.sort()).toEqual(["Circleback/n2.md", "Circleback/x2.md"]);
    expect(result.reported).toEqual(["Circleback/t1.md", "Circleback/t2.md"]);
  });

  it("does nothing for no groups", async () => {
    const app = createFakeApp({ files: { [KEEPER]: pluginFile() } });
    expect(await cleanUpDuplicates(app, [])).toEqual({ trashed: [], reported: [] });
  });

  it("works on a copy the metadata cache has not indexed yet", async () => {
    const app = createFakeApp({ files: twoCopies(), unindexed: [COPY] });
    const index = new MeetingIndex(app, () => ["Circleback"]);
    await index.build();
    const result = await cleanUpDuplicates(app, findDuplicates(index));
    expect(result.trashed).toEqual([COPY]);
  });

  it("leaves a copy alone and reports it when the file cannot be read", async () => {
    const app = createFakeApp({ files: twoCopies() });
    const groups = findDuplicates(await indexOf(app));
    const read = app.vault.read.bind(app.vault);
    jest.spyOn(app.vault, "read").mockImplementation(async (f: TFile) => {
      if (f.path === COPY) throw new Error("cannot read this one");
      return read(f);
    });
    const result = await cleanUpDuplicates(app, groups);
    expect(result.trashed).toEqual([]);
    expect(result.reported).toEqual([KEEPER, COPY]);
    expect(app.exists(COPY)).toBe(true);
  });

  it("leaves a copy alone and reports it when trashing fails, then carries on with the next one", async () => {
    const app = createFakeApp({
      files: {
        [KEEPER]: pluginFile({ firstSynced: "2026-10-20T10:00:00.000Z" }),
        [COPY]: pluginFile({ firstSynced: "2026-10-21T10:00:00.000Z" }),
        "Circleback/c copy.md": pluginFile({ firstSynced: "2026-10-22T10:00:00.000Z" }),
      },
    });
    const groups = findDuplicates(await indexOf(app));
    const trash = app.fileManager.trashFile.bind(app.fileManager);
    jest.spyOn(app.fileManager, "trashFile").mockImplementation(async (f) => {
      if (f.path === COPY) throw new Error("trash is full");
      return trash(f);
    });
    const result = await cleanUpDuplicates(app, groups);
    expect(result.trashed).toEqual(["Circleback/c copy.md"]);
    expect(result.reported).toEqual([KEEPER, COPY]);
    expect(app.exists(COPY)).toBe(true);
    expect(logger.dump()).toContain("trash is full");
  });

  it("forgets what it trashes when it is given the index, and only that", async () => {
    const app = createFakeApp({
      files: {
        ...twoCopies(),
        "Circleback/c edited.md": pluginFile({ firstSynced: "2026-10-22T10:00:00.000Z", extra: { people: ["Ada"] } }),
      },
    });
    const index = await indexOf(app);
    await cleanUpDuplicates(app, findDuplicates(index), index);
    expect(paths(index.find("m1", "note"))).toEqual([KEEPER, "Circleback/c edited.md"]);
    expect(index.frontmatter(file(app, KEEPER))).not.toBeNull();
  });

  it("leaves the index as it was when nothing is trashed", async () => {
    const app = createFakeApp({ files: twoCopies(pluginFile({ firstSynced: "2026-10-21T10:00:00.000Z", extra: { people: ["Ada"] } })) });
    const index = await indexOf(app);
    await cleanUpDuplicates(app, findDuplicates(index), index);
    expect(paths(index.find("m1", "note"))).toEqual([KEEPER, COPY]);
  });
});
