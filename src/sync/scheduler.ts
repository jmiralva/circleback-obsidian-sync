// The timer behind automatic syncs.
//
// It looks at the clock once a minute rather than sleeping until the next sync is due, because a
// timer that was set before the device slept fires late, and being late is how a wake shows. A
// check that comes more than two minutes later than a check should is treated as a wake, and the
// next run then waits for the settle delay, so the sync service can catch up first. The same
// settle delay follows the start of the scheduler, which main starts once the vault is ready.
import { logger } from "../util/logger";
import type { Timers } from "../util/timers";

/** How often the scheduler looks at the clock. */
export const CHECK_MS = 60_000;

/** How much later than `CHECK_MS` a check may come before it counts as a wake. */
const WAKE_GRACE_MS = 120_000;

export interface SchedulerDeps extends Timers {
  /** Runs one automatic sync. The scheduler never starts a second run while this one is going. */
  run: () => Promise<unknown>;
  /** Read at each run, so a settings edit applies from the next one. */
  intervalMs: () => number;
  /** Read at the start and at each wake. */
  settleMs: () => number;
  /** False while periodic sync is off or this device does not sync. */
  enabled: () => boolean;
  now: () => number;
}

/**
 * Turns a number of minutes from the settings into milliseconds: whole minutes, kept between `min`
 * and `max`, and `fallback` for anything that is not a finite number.
 */
export function minutesToMs(minutes: number, min: number, max: number, fallback: number): number {
  const whole = Number.isFinite(minutes) ? Math.min(max, Math.max(min, Math.round(minutes))) : fallback;
  return whole * 60_000;
}

export class Scheduler {
  private started = false;
  private timer: number | null = null;
  /** When the next automatic run is due. */
  private nextRunAt = 0;
  /** When the last check happened, enabled or not, so turning periodic sync on is not seen as a wake. */
  private lastCheckAt = 0;
  private running = false;

  constructor(private readonly deps: SchedulerDeps) {}

  /** Starts the checks. The first run waits for the settle delay. Does nothing when already started. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const now = this.deps.now();
    this.nextRunAt = now + this.deps.settleMs();
    this.lastCheckAt = now;
    this.scheduleCheck();
  }

  /** Ends the checks. A run that is already going is left to finish. */
  stop(): void {
    this.started = false;
    if (this.timer !== null) {
      this.deps.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * One check: runs a sync if one is due, unless periodic sync is off, a run is still going, or
   * the check itself came late (a wake). Public so tests can drive it. It never throws.
   */
  onTick(): void {
    try {
      this.check();
    } catch (error) {
      // A dependency that throws must not end the checks for good.
      logger.error("The automatic sync check failed.", error);
    }
  }

  private check(): void {
    const now = this.deps.now();
    const late = now - this.lastCheckAt > CHECK_MS + WAKE_GRACE_MS;
    this.lastCheckAt = now;
    if (!this.deps.enabled()) return;
    if (late) {
      // The device was asleep. Never bring a run forward: it may be due later than the settle delay.
      this.nextRunAt = Math.max(this.nextRunAt, now + this.deps.settleMs());
      return;
    }
    if (now < this.nextRunAt || this.running) return;
    // Set before the run starts, so the interval counts from its start.
    this.nextRunAt = now + this.deps.intervalMs();
    void this.execute();
  }

  private scheduleCheck(): void {
    this.timer = this.deps.setTimeout(() => {
      this.timer = null;
      this.onTick();
      if (this.started) this.scheduleCheck();
    }, CHECK_MS);
  }

  private async execute(): Promise<void> {
    this.running = true;
    try {
      await this.deps.run();
    } catch (error) {
      logger.error("The automatic sync failed.", error);
    } finally {
      this.running = false;
    }
  }
}
