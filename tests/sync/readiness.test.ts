import type { EventRef } from "obsidian";
import { Readiness } from "../../src/sync/readiness";
import { logger } from "../../src/util/logger";
import { createFakeApp, type FakeApp } from "../harness/fakeApp";
import { jestTimers } from "../harness/timers";

const FALLBACK_MS = 60_000;
const WARNING = "has not finished indexing";

function setup(opts: { layoutReady?: boolean } = {}): { app: FakeApp; readiness: Readiness; registered: EventRef[] } {
  const app = createFakeApp({ layoutReady: opts.layoutReady });
  const registered: EventRef[] = [];
  const readiness = new Readiness({ app, registerEvent: (ref) => registered.push(ref), ...jestTimers });
  return { app, readiness, registered };
}

/** How many times the fallback warning is in the log so far. */
function warnings(): number {
  return logger.dump().split(WARNING).length - 1;
}

/** Lets promise callbacks run. */
async function flush(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("Readiness", () => {
  it("is ready only when the layout is ready and the cache has resolved", () => {
    const { app, readiness } = setup({ layoutReady: false });
    expect(readiness.isReady).toBe(false);

    app.metadataCache.fireResolved();
    expect(readiness.isReady).toBe(false);

    app.workspace.fireLayoutReady();
    expect(readiness.isReady).toBe(true);
  });

  it("is ready when the layout comes first and the cache resolves after", () => {
    const { app, readiness } = setup({ layoutReady: false });
    app.workspace.fireLayoutReady();
    expect(readiness.isReady).toBe(false);

    app.metadataCache.fireResolved();
    expect(readiness.isReady).toBe(true);
  });

  it("registers its resolved listener through registerEvent so the plugin cleans it up", () => {
    const { registered } = setup({ layoutReady: false });
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ name: "resolved" });
  });

  it("counts the cache as resolved when the layout was already ready, as when the plugin is enabled later", async () => {
    const { readiness } = setup({ layoutReady: true });

    expect(readiness.isReady).toBe(true);
    await expect(readiness.whenReady()).resolves.toBeUndefined();
    // No fallback timer is needed.
    expect(jest.getTimerCount()).toBe(0);
  });

  it("whenReady resolves once ready, and at once when it already is", async () => {
    const { app, readiness } = setup({ layoutReady: false });
    const first = jest.fn();
    const second = jest.fn();
    void readiness.whenReady().then(first);
    void readiness.whenReady().then(second);
    await flush();
    expect(first).not.toHaveBeenCalled();

    app.workspace.fireLayoutReady();
    app.metadataCache.fireResolved();
    await flush();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    const late = jest.fn();
    void readiness.whenReady().then(late);
    await flush();
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("stays ready when the cache resolves again", () => {
    const { app, readiness } = setup({ layoutReady: true });
    app.metadataCache.fireResolved();
    app.metadataCache.fireResolved();
    expect(readiness.isReady).toBe(true);
  });

  it("falls back after 60 seconds of a ready layout with no resolved event, and warns once", async () => {
    const { app, readiness } = setup({ layoutReady: false });
    const before = warnings();
    app.workspace.fireLayoutReady();

    await jest.advanceTimersByTimeAsync(FALLBACK_MS - 1);
    expect(readiness.isReady).toBe(false);
    expect(warnings()).toBe(before);

    await jest.advanceTimersByTimeAsync(1);
    expect(readiness.isReady).toBe(true);
    expect(warnings()).toBe(before + 1);

    // A late resolved event neither warns again nor changes anything.
    app.metadataCache.fireResolved();
    await jest.advanceTimersByTimeAsync(FALLBACK_MS);
    expect(warnings()).toBe(before + 1);
  });

  it("does not start the fallback timer before the layout is ready", async () => {
    const { readiness } = setup({ layoutReady: false });
    expect(jest.getTimerCount()).toBe(0);

    await jest.advanceTimersByTimeAsync(10 * FALLBACK_MS);
    expect(readiness.isReady).toBe(false);
  });

  it("clears the fallback timer and does not warn when the cache resolves in time", async () => {
    const { app, readiness } = setup({ layoutReady: false });
    const before = warnings();
    app.workspace.fireLayoutReady();
    expect(jest.getTimerCount()).toBe(1);

    app.metadataCache.fireResolved();

    expect(readiness.isReady).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(FALLBACK_MS);
    expect(warnings()).toBe(before);
  });

  it("dispose clears the fallback timer and leaves anyone still waiting waiting", async () => {
    const { app, readiness } = setup({ layoutReady: false });
    const waiter = jest.fn();
    void readiness.whenReady().then(waiter);
    app.workspace.fireLayoutReady();

    readiness.dispose();

    expect(jest.getTimerCount()).toBe(0);
    app.metadataCache.fireResolved();
    await jest.advanceTimersByTimeAsync(FALLBACK_MS);
    expect(waiter).not.toHaveBeenCalled();
  });
});
