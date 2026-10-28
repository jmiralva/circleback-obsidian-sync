import { CHECK_MS, Scheduler, minutesToMs } from "../../src/sync/scheduler";
import { logger } from "../../src/util/logger";
import { jestTimers } from "../harness/timers";

const MIN = 60_000;

interface Setup {
  scheduler: Scheduler;
  run: jest.Mock<Promise<unknown>, []>;
  /** Moves the clock forward one check at a time, letting each check and the run it starts finish. */
  advance: (minutes: number) => Promise<void>;
  /** Calls `onTick` once a minute for that many minutes, without any timers. */
  tick: (minutes: number) => void;
  clock: { now: number; enabled: boolean; interval: number; settle: number };
}

function setup(opts: { run?: () => Promise<unknown> } = {}): Setup {
  const clock = { now: 1_000_000, enabled: true, interval: 30 * MIN, settle: 10 * MIN };
  const run = jest.fn<Promise<unknown>, []>(opts.run ?? (() => Promise.resolve()));
  const scheduler = new Scheduler({
    run,
    intervalMs: () => clock.interval,
    settleMs: () => clock.settle,
    enabled: () => clock.enabled,
    now: () => clock.now,
    ...jestTimers,
  });
  const advance = async (minutes: number): Promise<void> => {
    for (let i = 0; i < minutes; i++) {
      clock.now += MIN;
      await jest.advanceTimersByTimeAsync(MIN);
    }
  };
  const tick = (minutes: number): void => {
    for (let i = 0; i < minutes; i++) {
      clock.now += MIN;
      scheduler.onTick();
    }
  };
  return { scheduler, run, advance, tick, clock };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("Scheduler", () => {
  it("waits the settle delay before the first run", async () => {
    const { scheduler, run, advance } = setup();
    scheduler.start();

    await advance(9);
    expect(run).not.toHaveBeenCalled();

    await advance(1);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("runs again every interval after a run", async () => {
    const { scheduler, run, advance } = setup();
    scheduler.start();
    await advance(10);
    expect(run).toHaveBeenCalledTimes(1);

    await advance(29);
    expect(run).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(run).toHaveBeenCalledTimes(2);

    await advance(30);
    expect(run).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });

  it("treats a late tick as a wake and delays again", async () => {
    const { scheduler, run, advance, clock } = setup();
    scheduler.start();
    await advance(5);

    // The device sleeps for three hours: the next check fires late.
    clock.now += 180 * MIN;
    await jest.advanceTimersByTimeAsync(MIN);
    expect(run).not.toHaveBeenCalled();

    // The settle delay counts from the wake.
    await advance(9);
    expect(run).not.toHaveBeenCalled();
    await advance(1);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("calls a check a wake only when it is more than two minutes later than a check should be", () => {
    // Run due after 10 minutes. The check that finds it due comes `lateBy` after the nine regular ones.
    const runsWhenLateBy = (lateByMs: number): number => {
      const { scheduler, run, tick, clock } = setup();
      scheduler.start();
      tick(9);
      clock.now += CHECK_MS + lateByMs;
      scheduler.onTick();
      scheduler.stop();
      return run.mock.calls.length;
    };

    // Exactly two minutes late is still a normal check, so the run happens.
    expect(runsWhenLateBy(120_000)).toBe(1);
    // A second more is a wake, so the run waits.
    expect(runsWhenLateBy(121_000)).toBe(0);
  });

  it("never brings the next run forward on a wake", async () => {
    const { scheduler, run, advance, clock } = setup();
    scheduler.start();
    await advance(10);
    expect(run).toHaveBeenCalledTimes(1); // the next run is due 30 minutes later

    // A short sleep: the next check is a wake, and 10 minutes of settling from it would end
    // before the interval does.
    clock.now += 4 * MIN;
    await jest.advanceTimersByTimeAsync(MIN);
    await advance(25);
    expect(run).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(run).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("does not run while disabled, and runs at the next check once enabled", async () => {
    const { scheduler, run, advance, clock } = setup();
    clock.enabled = false;
    scheduler.start();

    await advance(120);
    expect(run).not.toHaveBeenCalled();

    // Periodic sync is turned on: the run time passed long ago, and the quiet checks since then
    // mean this is not a wake.
    clock.enabled = true;
    await advance(1);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("does not start a run while one is still going, and runs again once it ends", async () => {
    const gate = deferred();
    const { scheduler, run, advance } = setup({ run: () => gate.promise });
    scheduler.start();
    await advance(10);
    expect(run).toHaveBeenCalledTimes(1);

    // Two intervals pass with the first run still going.
    await advance(60);
    expect(run).toHaveBeenCalledTimes(1);

    gate.resolve();
    await advance(1);
    expect(run).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("stop ends the checks and clears the pending timer", async () => {
    const { scheduler, run, advance } = setup();
    scheduler.start();
    expect(jest.getTimerCount()).toBe(1);
    await advance(5);

    scheduler.stop();

    expect(jest.getTimerCount()).toBe(0);
    await advance(120);
    expect(run).not.toHaveBeenCalled();
  });

  it("does nothing when started twice", async () => {
    const { scheduler, run, advance } = setup();
    scheduler.start();
    await advance(5);
    scheduler.start();

    expect(jest.getTimerCount()).toBe(1);
    // The settle delay was not restarted by the second call.
    await advance(5);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("can be started again after it was stopped, with a new settle delay", async () => {
    const { scheduler, run, advance } = setup();
    scheduler.start();
    await advance(3);
    scheduler.stop();

    scheduler.start();
    await advance(9);
    expect(run).not.toHaveBeenCalled();
    await advance(1);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("logs a failed run and goes on", async () => {
    const { scheduler, run, advance } = setup({ run: () => Promise.reject(new Error("the run blew up")) });
    scheduler.start();

    await advance(10);
    expect(run).toHaveBeenCalledTimes(1);
    expect(logger.dump()).toContain("the run blew up");

    // The failed run is not left marked as going: the next interval runs again.
    await advance(30);
    expect(run).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("does not throw when the run throws at once instead of returning a promise", () => {
    const { scheduler, run, tick } = setup({
      run: () => {
        throw new Error("threw before returning");
      },
    });
    scheduler.start();
    tick(9);

    expect(() => tick(1)).not.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("keeps checking when something it asks throws", async () => {
    const { run, advance, clock } = setup();
    const broken = jest.fn(() => {
      throw new Error("settings unreadable");
    });
    const flaky = new Scheduler({
      run,
      intervalMs: () => clock.interval,
      settleMs: () => clock.settle,
      enabled: broken,
      now: () => clock.now,
      ...jestTimers,
    });
    flaky.start();

    expect(() => flaky.onTick()).not.toThrow();
    await advance(3);

    // The chain went on: the timer for the next check is still pending.
    expect(broken.mock.calls.length).toBeGreaterThan(3);
    expect(logger.dump()).toContain("settings unreadable");
    flaky.stop();
  });

  it("reads the interval and settle delay again each time", async () => {
    const { scheduler, run, advance, clock } = setup();
    clock.settle = 2 * MIN;
    scheduler.start();
    await advance(2);
    expect(run).toHaveBeenCalledTimes(1);

    clock.interval = 5 * MIN;
    await advance(5);
    expect(run).toHaveBeenCalledTimes(1); // the next run was set before the change
    await advance(25);
    expect(run).toHaveBeenCalledTimes(2);
    await advance(5);
    expect(run).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });
});

describe("minutesToMs", () => {
  it("rounds to whole minutes and clamps to the range", () => {
    expect(minutesToMs(30, 1, 1440, 30)).toBe(30 * MIN);
    expect(minutesToMs(2.6, 1, 1440, 30)).toBe(3 * MIN);
    expect(minutesToMs(0, 1, 1440, 30)).toBe(1 * MIN);
    expect(minutesToMs(-5, 1, 1440, 30)).toBe(1 * MIN);
    expect(minutesToMs(5000, 1, 1440, 30)).toBe(1440 * MIN);
    expect(minutesToMs(0, 0, 1440, 10)).toBe(0);
  });

  it("uses the fallback for a value that is not a finite number", () => {
    expect(minutesToMs(Number.NaN, 1, 1440, 30)).toBe(30 * MIN);
    expect(minutesToMs(Number.POSITIVE_INFINITY, 0, 1440, 10)).toBe(10 * MIN);
  });
});
