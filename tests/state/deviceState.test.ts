import { Plugin } from "obsidian";
import type { PluginManifest } from "obsidian";
import { createFakeApp } from "../harness/fakeApp";
import { DeviceState } from "../../src/state/deviceState";

const STORAGE_KEY = "circleback-sync-device-state";

describe("DeviceState: sync on this device", () => {
  it("defaults to on when nothing is stored", () => {
    expect(new DeviceState(createFakeApp()).syncOnThisDevice).toBe(true);
  });

  it("persists the toggle", () => {
    const app = createFakeApp();
    const state = new DeviceState(app);
    state.syncOnThisDevice = false;
    expect(state.syncOnThisDevice).toBe(false);
    expect(new DeviceState(app).syncOnThisDevice).toBe(false);
    state.syncOnThisDevice = true;
    expect(new DeviceState(app).syncOnThisDevice).toBe(true);
  });

  it("keeps the toggle when an account is updated, and the account when the toggle changes", () => {
    const app = createFakeApp();
    const state = new DeviceState(app);
    state.syncOnThisDevice = false;
    state.update("u1", { lastError: "x" });
    state.syncOnThisDevice = false;
    const reloaded = new DeviceState(app);
    expect(reloaded.syncOnThisDevice).toBe(false);
    expect(reloaded.account("u1").lastError).toBe("x");
  });
});

describe("DeviceState: accounts", () => {
  it("round-trips through local storage", () => {
    const app = createFakeApp();
    new DeviceState(app).update("u1", { lastError: "x" });
    expect(new DeviceState(app).account("u1").lastError).toBe("x");
  });

  it("round-trips every field", () => {
    const app = createFakeApp();
    const full = {
      lastSuccessAt: "2026-10-27T15:00:00.000Z",
      lastError: "auth",
      failing: true,
      ownerEmail: "jorge@example.com",
      ownerName: "Jorge Mir Alvarez",
      rateLimit: 300,
      fullSyncCursor: "/api/meetings?cursor=abc",
      fullSyncActive: true,
      forbiddenTranscripts: { m1: "2026-10-20T10:00:00.000Z", m2: "2026-10-21T10:00:00.000Z" },
    };
    new DeviceState(app).update("u1", full);
    expect(new DeviceState(app).account("u1")).toEqual(full);
  });

  it("keeps a null cursor distinct from no cursor", () => {
    const app = createFakeApp();
    new DeviceState(app).update("u1", { fullSyncCursor: null });
    const account = new DeviceState(app).account("u1");
    expect(account.fullSyncCursor).toBeNull();
    expect("fullSyncCursor" in new DeviceState(app).account("u2")).toBe(false);
  });

  it("returns an empty state for an account it has never seen", () => {
    expect(new DeviceState(createFakeApp()).account("nobody")).toEqual({});
  });

  it("merges a patch into what is there and leaves other fields alone", () => {
    const state = new DeviceState(createFakeApp());
    state.update("u1", { lastSuccessAt: "2026-10-27T15:00:00.000Z", rateLimit: 20 });
    state.update("u1", { lastError: "x", failing: true });
    expect(state.account("u1")).toEqual({
      lastSuccessAt: "2026-10-27T15:00:00.000Z",
      rateLimit: 20,
      lastError: "x",
      failing: true,
    });
  });

  it("clears a field when the patch sets it to undefined, in memory and on disk", () => {
    const app = createFakeApp();
    const state = new DeviceState(app);
    state.update("u1", { lastError: "x", failing: true });
    state.update("u1", { lastError: undefined, failing: false });
    expect(state.account("u1")).toEqual({ failing: false });
    expect("lastError" in state.account("u1")).toBe(false);
    expect(new DeviceState(app).account("u1")).toEqual({ failing: false });
  });

  it("replaces forbiddenTranscripts as a whole", () => {
    const state = new DeviceState(createFakeApp());
    state.update("u1", { forbiddenTranscripts: { m1: "t1" } });
    state.update("u1", { forbiddenTranscripts: { m2: "t2" } });
    expect(state.account("u1").forbiddenTranscripts).toEqual({ m2: "t2" });
  });

  it("keeps accounts apart", () => {
    const app = createFakeApp();
    const state = new DeviceState(app);
    state.update("u1", { lastError: "one" });
    state.update("u2", { lastError: "two" });
    const reloaded = new DeviceState(app);
    expect(reloaded.account("u1").lastError).toBe("one");
    expect(reloaded.account("u2").lastError).toBe("two");
  });

  it("hands out copies, so editing one does not change the state", () => {
    const app = createFakeApp();
    const state = new DeviceState(app);
    state.update("u1", { lastError: "x", forbiddenTranscripts: { m1: "t1" } });
    const copy = state.account("u1");
    copy.lastError = "changed";
    if (copy.forbiddenTranscripts) copy.forbiddenTranscripts.m9 = "t9";
    expect(state.account("u1")).toEqual({ lastError: "x", forbiddenTranscripts: { m1: "t1" } });
    expect(new DeviceState(app).account("u1")).toEqual({ lastError: "x", forbiddenTranscripts: { m1: "t1" } });
  });

  it("does not keep a reference to the patch it was given", () => {
    const state = new DeviceState(createFakeApp());
    const transcripts: Record<string, string> = { m1: "t1" };
    state.update("u1", { forbiddenTranscripts: transcripts });
    transcripts.m2 = "t2";
    expect(state.account("u1").forbiddenTranscripts).toEqual({ m1: "t1" });
  });
});

describe("DeviceState: where it writes", () => {
  it("never touches data.json", () => {
    const app = createFakeApp();
    const plugin = new (class extends Plugin {})(app, { id: "circleback-sync" } as PluginManifest);
    const saveData = jest.spyOn(plugin, "saveData");
    const state = new DeviceState(app);
    state.update("u1", { lastError: "x" });
    state.syncOnThisDevice = false;
    expect(saveData).not.toHaveBeenCalled();
  });

  it("writes only under circleback-sync-device-state", () => {
    const app = createFakeApp();
    const save = jest.spyOn(app, "saveLocalStorage");
    const state = new DeviceState(app);
    state.update("u1", { lastError: "x" });
    state.syncOnThisDevice = false;
    expect(save).toHaveBeenCalled();
    for (const call of save.mock.calls) expect(call[0]).toBe(STORAGE_KEY);
  });

  it("does not write when it is only created or read", () => {
    const app = createFakeApp();
    const save = jest.spyOn(app, "saveLocalStorage");
    const state = new DeviceState(app);
    state.account("u1");
    void state.syncOnThisDevice;
    expect(save).not.toHaveBeenCalled();
  });
});

describe("DeviceState: damaged local storage", () => {
  it("starts fresh when the stored value is not an object", () => {
    for (const bad of ["text", 42, [1, 2], true]) {
      const app = createFakeApp();
      app.saveLocalStorage(STORAGE_KEY, bad);
      const state = new DeviceState(app);
      expect(state.syncOnThisDevice).toBe(true);
      expect(state.account("u1")).toEqual({});
    }
  });

  it("ignores parts of the stored value that have the wrong shape", () => {
    const app = createFakeApp();
    app.saveLocalStorage(STORAGE_KEY, { syncOnThisDevice: "yes", accounts: { u1: "junk", u2: { lastError: "x" }, u3: [1] } });
    const state = new DeviceState(app);
    expect(state.syncOnThisDevice).toBe(true);
    expect(state.account("u1")).toEqual({});
    expect(state.account("u2")).toEqual({ lastError: "x" });
    expect(state.account("u3")).toEqual({});
  });

  it("ignores an accounts value that is not a mapping", () => {
    const app = createFakeApp();
    app.saveLocalStorage(STORAGE_KEY, { syncOnThisDevice: false, accounts: ["u1"] });
    const state = new DeviceState(app);
    expect(state.syncOnThisDevice).toBe(false);
    expect(state.account("u1")).toEqual({});
  });
});
