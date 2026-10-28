import { readFileSync } from "fs";
import { join } from "path";
import * as v from "valibot";
import type { TFile } from "obsidian";
import type { MeetingsPage } from "../../src/api/circlebackClient";
import { CirclebackError, type CirclebackErrorKind } from "../../src/api/errors";
import { MeetingListSchema, TranscriptSchema, type ConnectionInfo, type Meeting, type TranscriptSegment } from "../../src/api/schemas";
import { KeyStore } from "../../src/secrets/keyStore";
import { DEFAULT_SETTINGS, type AccountConfig, type CirclebackSyncSettings } from "../../src/settings/types";
import { DeviceState } from "../../src/state/deviceState";
import { SyncLock } from "../../src/sync/lock";
import { SyncEngine, type RunResult, type SyncClient } from "../../src/sync/syncEngine";
import { createFakeApp, type FakeApp } from "../harness/fakeApp";
import { pluginFile } from "../vault/meetingFile";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, "..", "fixtures", name), "utf8")) as unknown;
}

// Meeting 1 starts 2026-10-26T15:00Z (10:00 in Chicago). Its owner, both as an attendee named
// "Owner Person" and as the `sharedWith` Owner, is owner@example.com: account A's person.
const [ONE] = v.parse(MeetingListSchema, fixture("schema-meetings-page.json"));
const SEGMENTS = v.parse(TranscriptSchema, fixture("schema-transcript.json"));

// Two days after Meeting 1, so the default seven-day window holds it.
const NOW = new Date("2026-10-28T12:00:00.000Z");
const LATER = "2026-10-27T09:00:00.000Z";

const A: AccountConfig = { id: "a", label: "Work", selfNameOverride: "" };
const B: AccountConfig = { id: "b", label: "Personal", selfNameOverride: "" };
const A_EMAIL = "owner@example.com";
const B_EMAIL = "b.person@example.com";

/** Meeting 1 under another id and name, owned by account A's person unless changed. */
function meeting(id: string, changes: Partial<Meeting> = {}): Meeting {
  return { ...ONE, id, name: `Meeting ${id}`, ...changes };
}

function ownedBy(email: string, name = "Some Owner"): Pick<Meeting, "sharedWith"> {
  return { sharedWith: [{ name, email, access: "Owner" }] };
}

function notePath(id: string): string {
  return `Circleback/Meeting ${id}.md`;
}

function transcriptPath(id: string): string {
  return `Circleback/Transcripts/Meeting ${id}-transcript.md`;
}

function pageUrl(index: number): string {
  return `https://circleback.ai/api/meetings?cursor=${index}`;
}

function failure(kind: CirclebackErrorKind): CirclebackError {
  return new CirclebackError(kind, `fake ${kind} failure`);
}

/** What one account's Circleback answers. Tests may change it between runs. */
interface Script {
  email: string;
  /** Page 0 is asked for without a cursor, page n with `pageUrl(n)`. */
  pages: Meeting[][];
  /** The next link after a page. Defaults to the next page while there is one. */
  next?: (index: number) => string | null;
  /** By meeting id. Any meeting not listed gets SEGMENTS. */
  transcripts?: Record<string, TranscriptSegment[] | null>;
  transcriptErrors?: Record<string, CirclebackError>;
  testError?: CirclebackError;
  /** By page index. */
  pageErrors?: Record<number, CirclebackError>;
  rateLimit?: number;
}

/** A stand-in for one account's Circleback client that records what it was asked. */
class FakeCircleback implements SyncClient {
  testCalls = 0;
  readonly listCalls: Array<{ ownership: "Mine" | "All"; cursorUrl?: string }> = [];
  readonly transcriptCalls: string[] = [];
  /** Runs before a page is answered, so a test can look at state mid-sync or hold the sync up. */
  beforePage?: (index: number) => Promise<void> | void;

  constructor(readonly script: Script) {}

  get rateLimit(): number | undefined {
    return this.script.rateLimit;
  }

  async testConnection(): Promise<ConnectionInfo> {
    this.testCalls += 1;
    if (this.script.testError) throw this.script.testError;
    return { email: this.script.email, apiKeyName: "Test key" };
  }

  async listMeetingsPage(opts: { ownership: "Mine" | "All"; cursorUrl?: string }): Promise<MeetingsPage> {
    this.listCalls.push({ ...opts });
    const index = opts.cursorUrl === undefined ? 0 : Number(new URL(opts.cursorUrl).searchParams.get("cursor"));
    await this.beforePage?.(index);
    const error = this.script.pageErrors?.[index];
    if (error) throw error;
    const next = this.script.next ?? ((i: number) => (i + 1 < this.script.pages.length ? pageUrl(i + 1) : null));
    return { meetings: this.script.pages[index] ?? [], nextUrl: next(index) };
  }

  async getTranscript(meetingId: string): Promise<TranscriptSegment[] | null> {
    this.transcriptCalls.push(meetingId);
    const error = this.script.transcriptErrors?.[meetingId];
    if (error) throw error;
    const transcripts = this.script.transcripts ?? {};
    return meetingId in transcripts ? transcripts[meetingId] : SEGMENTS;
  }
}

interface SetupOptions {
  accounts?: AccountConfig[];
  /** By account id. An account with a script has a key on this device. */
  servers: Record<string, Script>;
  settings?: Partial<CirclebackSyncSettings>;
  files?: Record<string, string>;
}

interface Setup {
  app: FakeApp;
  device: DeviceState;
  engine: SyncEngine;
  server: (accountId: string) => FakeCircleback;
  /** The keys `clientFor` was called with, one per account per run. */
  clientsMade: string[];
  settings: CirclebackSyncSettings;
}

function setup(opts: SetupOptions): Setup {
  const app = createFakeApp({ files: opts.files });
  const keys = new KeyStore(app);
  const device = new DeviceState(app);
  const servers = new Map<string, FakeCircleback>();
  for (const [id, script] of Object.entries(opts.servers)) {
    keys.set(id, `cb_key_${id}`);
    servers.set(`cb_key_${id}`, new FakeCircleback(script));
  }
  const settings: CirclebackSyncSettings = {
    ...DEFAULT_SETTINGS,
    accounts: opts.accounts ?? [A],
    ...opts.settings,
  };
  const clientsMade: string[] = [];
  const engine = new SyncEngine({
    app,
    settings: () => settings,
    keys,
    device,
    clientFor: (key) => {
      clientsMade.push(key);
      const server = servers.get(key);
      if (!server) throw new Error(`no fake server for ${key}`);
      return server;
    },
    now: () => NOW,
  });
  const server = (accountId: string): FakeCircleback => {
    const found = servers.get(`cb_key_${accountId}`);
    if (!found) throw new Error(`no fake server for account ${accountId}`);
    return found;
  };
  return { app, device, engine, server, clientsMade, settings };
}

async function sync(engine: SyncEngine): Promise<RunResult> {
  const result = await engine.sync();
  if (result === "busy") throw new Error("the sync was busy");
  return result;
}

async function fullSync(
  engine: SyncEngine,
  onProgress: (done: number) => void = () => undefined,
  signal: { cancelled: boolean } = { cancelled: false },
): Promise<RunResult> {
  const result = await engine.fullSync(onProgress, signal);
  if (result === "busy") throw new Error("the full sync was busy");
  return result;
}

function frontmatter(app: FakeApp, path: string): Record<string, unknown> {
  const file = app.vault.getFileByPath(path);
  if (!file) throw new Error(`No such file: ${path}`);
  return app.metadataCache.getFileCache(file)?.frontmatter ?? {};
}

/** Every Markdown file whose frontmatter names this meeting. */
function filesOf(app: FakeApp, id: string): TFile[] {
  return app.vault.getMarkdownFiles().filter((file) => app.metadataCache.getFileCache(file)?.frontmatter?.circleback_id === id);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("SyncLock", () => {
  it("returns busy straight away while a call is running, and is free again after it fails", async () => {
    const lock = new SyncLock();
    const gate = deferred();
    const first = lock.run(async () => {
      await gate.promise;
      throw new Error("boom");
    });
    let ran = false;
    expect(
      await lock.run(async () => {
        ran = true;
      }),
    ).toBe("busy");
    expect(ran).toBe(false);

    gate.resolve();
    await expect(first).rejects.toThrow("boom");
    expect(await lock.run(async () => 42)).toBe(42);
  });
});

describe("SyncEngine.sync", () => {
  it("returns busy for an overlapping sync", async () => {
    const { engine, server } = setup({ servers: { a: { email: A_EMAIL, pages: [[meeting("m1")]] } } });
    const started = deferred();
    const release = deferred();
    server("a").beforePage = async () => {
      started.resolve();
      await release.promise;
    };

    const first = engine.sync();
    await started.promise;
    expect(await engine.sync()).toBe("busy");
    expect(await engine.fullSync(() => undefined, { cancelled: false })).toBe("busy");

    release.resolve();
    const result = await first;
    expect(result).not.toBe("busy");
    server("a").beforePage = undefined;
    expect(await engine.sync()).not.toBe("busy");
  });

  it("writes one note for a meeting seen by two accounts", async () => {
    // B comes first in the settings, but A's person owns the meeting, so A writes it.
    const { app, engine } = setup({
      accounts: [B, A],
      servers: {
        a: { email: A_EMAIL, pages: [[meeting("m1")]] },
        b: { email: B_EMAIL, pages: [[meeting("m1", { privateNotes: "B's own notes" })]] },
      },
    });

    const result = await sync(engine);

    expect(filesOf(app, "m1").map((file) => file.path)).toEqual([notePath("m1")]);
    expect(frontmatter(app, notePath("m1")).circleback_account).toBe("Work");
    expect(result.perAccount.a).toMatchObject({ ok: true, written: 1 });
    expect(result.perAccount.b).toMatchObject({ ok: true, written: 0 });

    await sync(engine);
    expect(filesOf(app, "m1")).toHaveLength(1);
  });

  it("keeps syncing account B when account A fails auth", async () => {
    const { app, engine, device } = setup({
      accounts: [A, B],
      servers: {
        a: { email: A_EMAIL, pages: [[meeting("m1")]], testError: failure("auth") },
        b: { email: B_EMAIL, pages: [[meeting("m2", ownedBy(B_EMAIL))]] },
      },
    });

    const result = await sync(engine);

    expect(result.perAccount.a).toMatchObject({ ok: false, error: "auth", written: 0 });
    expect(result.perAccount.b.ok).toBe(true);
    expect(result.perAccount.b.written).toBeGreaterThan(0);
    expect(app.exists(notePath("m2"))).toBe(true);
    expect(app.exists(notePath("m1"))).toBe(false);
    expect(device.account("a")).toMatchObject({ failing: true, lastError: "auth" });
  });

  it("records an error that is not Circleback's as unexpected, and keeps syncing the other accounts", async () => {
    const { app, engine, server } = setup({
      accounts: [A, B],
      servers: {
        a: { email: A_EMAIL, pages: [[meeting("m1")]] },
        b: { email: B_EMAIL, pages: [[meeting("m2", ownedBy(B_EMAIL))]] },
      },
    });
    server("a").beforePage = () => {
      throw new TypeError("a bug");
    };

    const result = await sync(engine);

    expect(result.perAccount.a).toMatchObject({ ok: false, error: "unexpected" });
    expect(result.perAccount.b).toMatchObject({ ok: true, written: 1 });
    expect(app.exists(notePath("m2"))).toBe(true);
  });

  it("skips accounts without a key on this device", async () => {
    const { engine, clientsMade } = setup({
      accounts: [A, B],
      servers: { b: { email: B_EMAIL, pages: [[meeting("m2", ownedBy(B_EMAIL))]] } },
    });

    const result = await sync(engine);

    expect(Object.keys(result.perAccount)).toEqual(["b"]);
    expect(clientsMade).toEqual(["cb_key_b"]);
  });

  it("does nothing when sync on this device is off", async () => {
    const { app, engine, device, clientsMade } = setup({ servers: { a: { email: A_EMAIL, pages: [[meeting("m1")]] } } });
    device.syncOnThisDevice = false;

    expect(await sync(engine)).toEqual({ perAccount: {}, duplicates: [] });
    expect(await fullSync(engine)).toEqual({ perAccount: {}, duplicates: [] });
    expect(clientsMade).toEqual([]);
    expect(app.vault.getMarkdownFiles()).toEqual([]);
    expect(device.account("a")).toEqual({});
  });

  it("records invalid-response without writing that account's page", async () => {
    // Page 0 is fine and page 1 fails validation: nothing of A's is written, B carries on.
    const { app, engine, device } = setup({
      accounts: [A, B],
      servers: {
        a: { email: A_EMAIL, pages: [[meeting("m1")], [meeting("m2")]], pageErrors: { 1: failure("invalid-response") } },
        b: { email: B_EMAIL, pages: [[meeting("m3", ownedBy(B_EMAIL))]] },
      },
    });

    const result = await sync(engine);

    expect(result.perAccount.a).toMatchObject({ ok: false, error: "invalid-response", written: 0 });
    expect(filesOf(app, "m1")).toEqual([]);
    expect(filesOf(app, "m2")).toEqual([]);
    expect(result.perAccount.b).toMatchObject({ ok: true, written: 1 });
    expect(app.exists(notePath("m3"))).toBe(true);
    expect(device.account("a")).toMatchObject({ failing: true, lastError: "invalid-response" });
  });

  it("caches the owner email from testConnection once", async () => {
    const { engine, server, device, clientsMade } = setup({ servers: { a: { email: A_EMAIL, pages: [[meeting("m1")]] } } });

    await sync(engine);
    await sync(engine);

    expect(server("a").testCalls).toBe(1);
    expect(device.account("a").ownerEmail).toBe(A_EMAIL);
    // A client is made per account per run.
    expect(clientsMade).toEqual(["cb_key_a", "cb_key_a"]);
  });

  it("caches the owner name from the first meeting that names the owner", async () => {
    const nameless = meeting("m1", {
      attendees: [{ profileId: 1, name: null, email: A_EMAIL }],
      sharedWith: [{ name: null, email: A_EMAIL, access: "Owner" }],
    });
    const { app, engine, device } = setup({
      servers: { a: { email: A_EMAIL, pages: [[nameless], [meeting("m2")]] } },
      settings: { syncTranscripts: true },
    });

    await sync(engine);

    expect(device.account("a").ownerName).toBe("Owner Person");
    // The name is known before anything is written, so the owner's lines are "You" in both transcripts.
    for (const id of ["m1", "m2"]) {
      expect(app.fileText(transcriptPath(id))).toContain("### You (");
      expect(app.fileText(transcriptPath(id))).not.toContain("### Owner Person (");
    }
  });

  it("requests shared meetings only when includeShared is on", async () => {
    const mine = setup({ servers: { a: { email: A_EMAIL, pages: [[meeting("m1")], [meeting("m2")]] } } });
    await sync(mine.engine);
    expect(mine.server("a").listCalls.map((call) => call.ownership)).toEqual(["Mine", "Mine"]);

    const all = setup({
      servers: { a: { email: A_EMAIL, pages: [[meeting("m1")], [meeting("m2")]] } },
      settings: { includeShared: true },
    });
    await sync(all.engine);
    await fullSync(all.engine);
    expect(all.server("a").listCalls.map((call) => call.ownership)).toEqual(["All", "All", "All", "All"]);
  });

  it("writes only meetings inside the sync window that have notes", async () => {
    const old = meeting("old", { createdAt: "2026-10-01T15:00:00.000Z", updatedAt: "2026-10-01T16:00:00.000Z" });
    const unfinished = meeting("unfinished", { notes: null });
    const { app, engine } = setup({ servers: { a: { email: A_EMAIL, pages: [[meeting("m1"), old, unfinished]] } } });

    const result = await sync(engine);

    expect(result.perAccount.a.written).toBe(1);
    expect(app.exists(notePath("m1"))).toBe(true);
    expect(filesOf(app, "old")).toEqual([]);
    expect(filesOf(app, "unfinished")).toEqual([]);
  });

  it("fetches no transcripts when transcripts are off", async () => {
    const { app, engine, server } = setup({ servers: { a: { email: A_EMAIL, pages: [[meeting("m1")]] } } });

    await sync(engine);

    expect(server("a").transcriptCalls).toEqual([]);
    expect(app.exists(transcriptPath("m1"))).toBe(false);
  });

  it("does not fetch the transcript again for a meeting the vault already has", async () => {
    const { app, engine, server } = setup({
      servers: { a: { email: A_EMAIL, pages: [[meeting("m1")]] } },
      settings: { syncTranscripts: true },
    });

    const first = await sync(engine);
    const second = await sync(engine);

    expect(app.exists(transcriptPath("m1"))).toBe(true);
    expect(server("a").transcriptCalls).toEqual(["m1"]);
    expect(first.perAccount.a).toMatchObject({ written: 1, skipped: 0 });
    expect(second.perAccount.a).toMatchObject({ written: 0, skipped: 1 });
  });

  it("does not re-request a forbidden transcript until the meeting changes", async () => {
    const { app, engine, server, device } = setup({
      servers: { a: { email: A_EMAIL, pages: [[meeting("m1")]], transcripts: { m1: null } } },
      settings: { syncTranscripts: true },
    });

    const first = await sync(engine);
    expect(first.perAccount.a).toMatchObject({ ok: true, written: 1 });
    expect(app.exists(notePath("m1"))).toBe(true);
    expect(app.exists(transcriptPath("m1"))).toBe(false);
    expect(device.account("a").forbiddenTranscripts).toEqual({ m1: ONE.updatedAt });

    // Neither a normal sync nor a full sync (which rewrites the note) asks again.
    await sync(engine);
    await fullSync(engine);
    expect(server("a").transcriptCalls).toEqual(["m1"]);

    // Once the meeting changes, it is asked for again, and a success forgets the 403.
    server("a").script.pages = [[meeting("m1", { updatedAt: LATER })]];
    server("a").script.transcripts = {};
    await sync(engine);
    expect(server("a").transcriptCalls).toEqual(["m1", "m1"]);
    expect(app.exists(transcriptPath("m1"))).toBe(true);
    expect(device.account("a").forbiddenTranscripts).toEqual({});
  });

  it("asks again next sync for a transcript that came back empty, without recording it as forbidden", async () => {
    const { app, engine, server, device } = setup({
      servers: { a: { email: A_EMAIL, pages: [[meeting("m1")]], transcripts: { m1: [] } } },
      settings: { syncTranscripts: true },
    });

    await sync(engine);
    expect(app.exists(notePath("m1"))).toBe(true);
    expect(app.exists(transcriptPath("m1"))).toBe(false);
    expect(device.account("a").forbiddenTranscripts).toBeUndefined();

    server("a").script.transcripts = {};
    await sync(engine);
    expect(server("a").transcriptCalls).toEqual(["m1", "m1"]);
    expect(app.exists(transcriptPath("m1"))).toBe(true);
  });

  it("stops an account at a transcript auth error and keeps the other accounts going", async () => {
    const { app, engine, server, device } = setup({
      accounts: [A, B],
      servers: {
        a: { email: A_EMAIL, pages: [[meeting("m1"), meeting("m2")]], transcriptErrors: { m1: failure("auth") } },
        b: { email: B_EMAIL, pages: [[meeting("m3", ownedBy(B_EMAIL))]] },
      },
      settings: { syncTranscripts: true },
    });

    const result = await sync(engine);

    expect(result.perAccount.a).toMatchObject({ ok: false, error: "auth", written: 0 });
    expect(server("a").transcriptCalls).toEqual(["m1"]);
    expect(filesOf(app, "m1")).toEqual([]);
    expect(filesOf(app, "m2")).toEqual([]);
    expect(result.perAccount.b).toMatchObject({ ok: true, written: 1 });
    expect(device.account("a")).toMatchObject({ failing: true, lastError: "auth" });
  });

  it("skips only the meeting whose transcript fails another way, and tries it again next sync", async () => {
    const { app, engine, server, device } = setup({
      servers: { a: { email: A_EMAIL, pages: [[meeting("m1"), meeting("m2")]], transcriptErrors: { m1: failure("server") } } },
      settings: { syncTranscripts: true },
    });

    const first = await sync(engine);
    expect(first.perAccount.a).toMatchObject({ ok: true, written: 1, failed: 1 });
    expect(filesOf(app, "m1")).toEqual([]);
    expect(app.exists(notePath("m2"))).toBe(true);
    expect(device.account("a").failing).toBe(false);

    server("a").script.transcriptErrors = {};
    const second = await sync(engine);
    expect(second.perAccount.a).toMatchObject({ written: 1, skipped: 1, failed: 0 });
    expect(app.exists(transcriptPath("m1"))).toBe(true);
  });

  it("counts a meeting the vault will not take as failed and goes on with the next", async () => {
    const { app, engine, device } = setup({ servers: { a: { email: A_EMAIL, pages: [[meeting("m1"), meeting("m2")]] } } });
    const create = app.vault.create.bind(app.vault);
    jest.spyOn(app.vault, "create").mockImplementation(async (path: string, data: string) => {
      if (path === notePath("m1")) throw new Error("disk full");
      return create(path, data);
    });

    const result = await sync(engine);

    expect(result.perAccount.a).toMatchObject({ ok: true, written: 1, failed: 1 });
    expect(app.exists(notePath("m2"))).toBe(true);
    expect(device.account("a")).toMatchObject({ failing: false });
    expect(device.account("a").lastError).toBeUndefined();
  });

  it("links every meeting from its daily note on every sync, including meetings it did not rewrite", async () => {
    const { app, engine, settings } = setup({ servers: { a: { email: A_EMAIL, pages: [[meeting("m1")]] } } });

    await sync(engine);
    expect(app.exists("2026-10-26.md")).toBe(false);

    // Linking turned on later: the note is current, so it is skipped, and still linked.
    settings.linkFromDailyNotes = true;
    settings.dailyNoteLinkHeading = "## Meetings";
    const result = await sync(engine);
    expect(result.perAccount.a).toMatchObject({ written: 0, skipped: 1 });
    expect(app.fileText("2026-10-26.md")).toContain("- 10:00 - [[Circleback/Meeting m1|Meeting m1]]");
  });

  it("still counts a meeting as written when its daily note cannot be linked, and links it on the next sync", async () => {
    const { app, engine } = setup({
      servers: { a: { email: A_EMAIL, pages: [[meeting("m1")]] } },
      settings: { linkFromDailyNotes: true, dailyNoteLinkHeading: "## Meetings" },
    });
    const original = app.vault.create.bind(app.vault);
    const create = jest.spyOn(app.vault, "create").mockImplementation(async (path: string, data: string) => {
      if (path === "2026-10-26.md") throw new Error("not yet");
      return original(path, data);
    });

    const first = await sync(engine);
    expect(first.perAccount.a).toMatchObject({ ok: true, written: 1, failed: 0 });
    expect(app.exists("2026-10-26.md")).toBe(false);

    create.mockRestore();
    await sync(engine);
    expect(app.fileText("2026-10-26.md")).toContain("[[Circleback/Meeting m1|Meeting m1]]");
  });

  it("moves a meeting's daily-note line when its date changes", async () => {
    const { app, engine, server } = setup({
      servers: { a: { email: A_EMAIL, pages: [[meeting("m1")]] } },
      settings: { linkFromDailyNotes: true, dailyNoteLinkHeading: "## Meetings" },
    });
    await sync(engine);
    expect(app.fileText("2026-10-26.md")).toContain("[[Circleback/Meeting m1|Meeting m1]]");

    server("a").script.pages = [[meeting("m1", { createdAt: "2026-10-27T15:00:00.000Z", updatedAt: LATER })]];
    await sync(engine);
    expect(app.fileText("2026-10-27.md")).toContain("- 10:00 - [[Circleback/Meeting m1|Meeting m1]]");
    expect(app.fileText("2026-10-26.md")).not.toContain("Meeting m1");
  });

  it("writes the meeting into its daily note's section in sections mode", async () => {
    const { app, engine } = setup({
      servers: { a: { email: A_EMAIL, pages: [[meeting("m1")]] } },
      settings: { saveAs: "sections" },
    });

    const first = await sync(engine);
    const daily = app.fileText("2026-10-26.md");
    expect(daily).toContain("# Circleback notes");
    expect(daily).toContain("%% circleback-start m1 %%");
    expect(daily).toContain("Lorem ipsum dolor sit amet, consectetur adipiscing elit.");
    expect(daily).toContain("View in Circleback: https://circleback.ai/meetings/m1");
    expect(app.exists(notePath("m1"))).toBe(false);
    expect(first.perAccount.a).toMatchObject({ written: 1, skipped: 0 });

    const second = await sync(engine);
    expect(app.fileText("2026-10-26.md")).toBe(daily);
    expect(second.perAccount.a).toMatchObject({ written: 0, skipped: 1 });
  });

  it("counts a daily-note block it cannot write as failed in sections mode, and writes it on the next sync", async () => {
    const { app, engine } = setup({
      servers: { a: { email: A_EMAIL, pages: [[meeting("m1")]] } },
      settings: { saveAs: "sections" },
    });
    const original = app.vault.create.bind(app.vault);
    const create = jest.spyOn(app.vault, "create").mockImplementation(async (path: string, data: string) => {
      if (path === "2026-10-26.md") throw new Error("not yet");
      return original(path, data);
    });

    const first = await sync(engine);
    expect(first.perAccount.a).toMatchObject({ ok: true, written: 0, failed: 1 });

    create.mockRestore();
    const second = await sync(engine);
    expect(second.perAccount.a).toMatchObject({ written: 1, failed: 0 });
    expect(app.fileText("2026-10-26.md")).toContain("%% circleback-start m1 %%");
  });

  it("in sections mode, keeps a combined transcript in a file of its own and does not fetch it again", async () => {
    const { app, engine, server } = setup({
      servers: { a: { email: A_EMAIL, pages: [[meeting("m1")]] } },
      settings: { saveAs: "sections", transcriptHandling: "combined", syncTranscripts: true },
    });

    await sync(engine);
    await sync(engine);

    // Same location as the notes: beside the daily notes, which are in the vault root here.
    expect(frontmatter(app, "Meeting m1-transcript.md").circleback_kind).toBe("transcript");
    const daily = app.fileText("2026-10-26.md");
    expect(daily).toContain("%% circleback-start m1 %%");
    expect(daily).not.toContain("Transcript");
    expect(daily).not.toContain("### Person A (");
    expect(server("a").transcriptCalls).toEqual(["m1"]);
  });

  it("reports duplicates and trashes only when cleanUpDuplicates is on", async () => {
    const files = {
      "Circleback/Dup.md": pluginFile({ id: "dup", firstSynced: "2026-10-20T10:00:00.000Z" }),
      "Circleback/Dup copy.md": pluginFile({ id: "dup", firstSynced: "2026-10-21T10:00:00.000Z" }),
    };
    const { app, engine, settings } = setup({ servers: { a: { email: A_EMAIL, pages: [[]] } }, files });

    const reported = await sync(engine);
    expect(reported.duplicates).toHaveLength(1);
    expect(reported.duplicates[0]).toMatchObject({ id: "dup", kind: "note" });
    expect(reported.duplicates[0].keep.path).toBe("Circleback/Dup.md");
    expect(reported.duplicates[0].others.map((file) => file.path)).toEqual(["Circleback/Dup copy.md"]);
    expect(app.exists("Circleback/Dup copy.md")).toBe(true);

    settings.cleanUpDuplicates = true;
    const cleaned = await sync(engine);
    expect(cleaned.duplicates).toEqual([]);
    expect(app.exists("Circleback/Dup.md")).toBe(true);
    expect(app.exists("Circleback/Dup copy.md")).toBe(false);
  });

  it("uses selfNameOverride over the cached owner name", async () => {
    const { app, engine, device } = setup({
      accounts: [{ ...A, selfNameOverride: " Jorge M " }],
      servers: {
        a: {
          email: A_EMAIL,
          pages: [[meeting("m1")]],
          transcripts: {
            m1: [
              { speaker: "Owner Person", text: "Hello.", timestamp: 0 },
              { speaker: "Jorge M", text: "Hi there.", timestamp: 5 },
            ],
          },
        },
      },
      settings: { syncTranscripts: true },
    });
    device.update("a", { ownerEmail: A_EMAIL, ownerName: "Owner Person" });

    await sync(engine);

    const transcript = app.fileText(transcriptPath("m1"));
    expect(transcript).toContain("### Owner Person (");
    expect(transcript).toContain("### You (");
    expect(transcript.indexOf("### You (")).toBeGreaterThan(transcript.indexOf("### Owner Person ("));
  });

  it("records each account's outcome in device state", async () => {
    const { engine, device, server } = setup({
      accounts: [A, B],
      servers: {
        a: { email: A_EMAIL, pages: [[meeting("m1")]], rateLimit: 300 },
        b: { email: B_EMAIL, pages: [[]], pageErrors: { 0: failure("network") } },
      },
    });

    await sync(engine);
    expect(device.account("a")).toMatchObject({ lastSuccessAt: NOW.toISOString(), failing: false, rateLimit: 300 });
    expect(device.account("a").lastError).toBeUndefined();
    expect(device.account("b")).toMatchObject({ failing: true, lastError: "network" });
    expect(device.account("b").lastSuccessAt).toBeUndefined();
    expect(device.account("b").rateLimit).toBeUndefined();

    server("b").script.pageErrors = {};
    await sync(engine);
    expect(device.account("b")).toMatchObject({ lastSuccessAt: NOW.toISOString(), failing: false });
    expect(device.account("b").lastError).toBeUndefined();
  });

  it("stops paging an account when Circleback repeats a next link", async () => {
    const { app, engine, server } = setup({
      servers: { a: { email: A_EMAIL, pages: [[meeting("m1")], [meeting("m2")]], next: () => pageUrl(1) } },
    });

    const result = await sync(engine);

    expect(result.perAccount.a).toMatchObject({ ok: false, error: "invalid-response" });
    expect(server("a").listCalls).toHaveLength(2);
    expect(filesOf(app, "m1")).toEqual([]);
  });
});

describe("SyncEngine.fullSync", () => {
  it("full sync resumes from the saved cursor and stops when cancelled", async () => {
    const { app, engine, server, device } = setup({
      servers: { a: { email: A_EMAIL, pages: [[meeting("m1")], [meeting("m2")], [meeting("m3")], [meeting("m4")]] } },
    });
    device.update("a", { ownerEmail: A_EMAIL, fullSyncActive: true, fullSyncCursor: pageUrl(1) });
    const signal = { cancelled: false };
    const progress: number[] = [];

    const result = await fullSync(
      engine,
      (done) => {
        progress.push(done);
        // Cancelled while page 1 is being written: page 2 is never asked for.
        signal.cancelled = true;
      },
      signal,
    );

    expect(server("a").listCalls.map((call) => call.cursorUrl)).toEqual([pageUrl(1)]);
    expect(filesOf(app, "m1")).toEqual([]);
    expect(app.exists(notePath("m2"))).toBe(true);
    expect(filesOf(app, "m3")).toEqual([]);
    expect(progress).toEqual([1]);
    expect(result.perAccount.a).toMatchObject({ ok: true, written: 1 });
    // The user chose to stop, so the next full sync starts over.
    expect(device.account("a").fullSyncActive).toBeUndefined();
    expect(device.account("a").fullSyncCursor).toBeUndefined();
  });

  it("saves the cursor after each page, ignores the window, rewrites current notes, and clears the cursor when done", async () => {
    const old = meeting("old", { createdAt: "2025-01-06T15:00:00.000Z", updatedAt: "2025-01-06T16:00:00.000Z" });
    const { app, engine, server, device } = setup({
      servers: { a: { email: A_EMAIL, pages: [[old], [meeting("m1")]] } },
    });
    await sync(engine);
    const note = app.vault.getFileByPath(notePath("m1"));
    if (!note) throw new Error("no note");
    await app.vault.process(note, (text) => text.replace("View in Circleback", "Edited by hand"));

    const seen: Array<{ active?: boolean; cursor?: string | null }> = [];
    server("a").beforePage = () => {
      const state = device.account("a");
      seen.push({ active: state.fullSyncActive, cursor: state.fullSyncCursor });
    };
    const progress: number[] = [];
    const result = await fullSync(engine, (done) => progress.push(done));

    expect(seen).toEqual([
      { active: true, cursor: null },
      { active: true, cursor: pageUrl(1) },
    ]);
    expect(app.exists(notePath("old"))).toBe(true);
    expect(app.fileText(notePath("m1"))).toContain("View in Circleback");
    expect(app.fileText(notePath("m1"))).not.toContain("Edited by hand");
    expect(progress).toEqual([1, 2]);
    expect(result.perAccount.a).toMatchObject({ ok: true, written: 2 });
    expect(device.account("a").fullSyncActive).toBeUndefined();
    expect(device.account("a").fullSyncCursor).toBeUndefined();
    expect(device.account("a").lastSuccessAt).toBe(NOW.toISOString());
  });

  it("resumes only the accounts an interrupted full sync had not finished", async () => {
    const { engine, server, device } = setup({
      accounts: [A, B],
      servers: {
        a: { email: A_EMAIL, pages: [[meeting("m1")]] },
        b: { email: B_EMAIL, pages: [[meeting("m2", ownedBy(B_EMAIL))], [meeting("m3", ownedBy(B_EMAIL))]] },
      },
    });
    // A finished before Obsidian closed; B was on its second page.
    device.update("a", { ownerEmail: A_EMAIL });
    device.update("b", { ownerEmail: B_EMAIL, fullSyncActive: true, fullSyncCursor: pageUrl(1) });

    const result = await fullSync(engine);

    expect(server("a").listCalls).toEqual([]);
    expect(server("b").listCalls.map((call) => call.cursorUrl)).toEqual([pageUrl(1)]);
    expect(Object.keys(result.perAccount)).toEqual(["b"]);
    expect(device.account("b").fullSyncActive).toBeUndefined();
  });

  it("leaves a meeting owned by another connected account to that account", async () => {
    const nobodys = meeting("m2", ownedBy("someone@example.com"));
    const { app, engine, server } = setup({
      accounts: [B, A],
      servers: {
        a: { email: A_EMAIL, pages: [[meeting("m1"), nobodys]] },
        b: { email: B_EMAIL, pages: [[meeting("m1"), nobodys]] },
      },
      settings: { syncTranscripts: true },
    });

    const result = await fullSync(engine);

    // B goes first: it leaves m1 to A, which owns it, and writes m2, which no connected account owns.
    expect(frontmatter(app, notePath("m1")).circleback_account).toBe("Work");
    expect(frontmatter(app, notePath("m2")).circleback_account).toBe("Personal");
    expect(server("b").transcriptCalls).toEqual(["m2"]);
    expect(server("a").transcriptCalls).toEqual(["m1"]);
    expect(result.perAccount.b).toMatchObject({ written: 1 });
    expect(result.perAccount.a).toMatchObject({ written: 1 });
  });

  it("ends a failing account's full sync and goes on with the next account", async () => {
    const { app, engine, device } = setup({
      accounts: [A, B],
      servers: {
        a: { email: A_EMAIL, pages: [[meeting("m1")], [meeting("m2")]], pageErrors: { 1: failure("network") } },
        b: { email: B_EMAIL, pages: [[meeting("m3", ownedBy(B_EMAIL))]] },
      },
    });

    const result = await fullSync(engine);

    expect(result.perAccount.a).toMatchObject({ ok: false, error: "network", written: 1 });
    expect(result.perAccount.b).toMatchObject({ ok: true, written: 1 });
    expect(app.exists(notePath("m3"))).toBe(true);
    expect(device.account("a")).toMatchObject({ failing: true, lastError: "network" });
    expect(device.account("a").fullSyncActive).toBeUndefined();
    expect(device.account("a").fullSyncCursor).toBeUndefined();
  });
});
