// The gate in front of every sync: the workspace layout is ready and the metadata cache has
// finished its first index of the vault, so the note index never sees a half-indexed vault.
//
// A plugin that is enabled after startup finds the vault already indexed: `resolved` only fires
// again after a file changes, so that case counts as seen from the start. The same event can be
// missed in a quiet vault at startup, so a 60 second fallback opens the gate anyway. That is safe
// because the meeting index also reads the files the cache has not reached yet.
import type { App, EventRef } from "obsidian";
import { logger } from "../util/logger";
import type { Timers } from "../util/timers";

/** How long a ready layout waits for `resolved` before the gate opens without it. */
const FALLBACK_MS = 60_000;

export interface ReadinessDeps extends Timers {
  app: App;
  /** The plugin's `registerEvent`, so the listener is removed when the plugin unloads. */
  registerEvent: (ref: EventRef) => void;
}

export class Readiness {
  private layoutReady = false;
  private resolvedSeen: boolean;
  private open = false;
  private fallbackTimer: number | null = null;
  private waiting: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly deps: ReadinessDeps) {
    const { app } = deps;
    // Already ready means the plugin was enabled after startup, when the index has long finished.
    this.resolvedSeen = app.workspace.layoutReady;
    deps.registerEvent(
      app.metadataCache.on("resolved", () => {
        this.resolvedSeen = true;
        this.update();
      }),
    );
    app.workspace.onLayoutReady(() => {
      this.layoutReady = true;
      this.update();
    });
  }

  /** True once the layout is ready and the cache has resolved (or the fallback has passed). */
  get isReady(): boolean {
    return this.open;
  }

  /** Resolves once the vault is ready, and at once when it already is. */
  whenReady(): Promise<void> {
    if (this.open) return Promise.resolve();
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /**
   * For unload: clears the fallback timer and leaves anyone still waiting waiting, so nothing
   * starts after the plugin is gone.
   */
  dispose(): void {
    this.disposed = true;
    this.waiting = [];
    this.clearFallback();
  }

  private update(): void {
    if (this.disposed || this.open) return;
    if (this.layoutReady && this.resolvedSeen) {
      this.open = true;
      this.clearFallback();
      const waiting = this.waiting;
      this.waiting = [];
      for (const resolve of waiting) resolve();
    } else if (this.layoutReady && this.fallbackTimer === null) {
      this.fallbackTimer = this.deps.setTimeout(() => {
        this.fallbackTimer = null;
        logger.warn(
          "Obsidian has not finished indexing the vault 60 seconds after startup; " +
            "starting syncs anyway, because the note index reads the files the cache has not reached.",
        );
        this.resolvedSeen = true;
        this.update();
      }, FALLBACK_MS);
    }
  }

  private clearFallback(): void {
    if (this.fallbackTimer === null) return;
    this.deps.clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
  }
}
