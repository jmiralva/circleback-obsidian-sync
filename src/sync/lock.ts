// One sync at a time on this device.
//
// A sync that arrives while another one runs is turned away at once, never queued and never
// run alongside: two runs writing the same vault could each decide a meeting has no note yet.

export class SyncLock {
  #running = false;

  /**
   * Runs `fn` unless a call is already running, in which case it resolves to `"busy"` straight
   * away without calling `fn`. The lock is free again once `fn` settles, whether it resolved or
   * threw; a throw is passed on.
   */
  async run<T>(fn: () => Promise<T>): Promise<T | "busy"> {
    // An async function runs up to its first await synchronously, so two calls made in the same
    // tick cannot both see the lock free.
    if (this.#running) return "busy";
    this.#running = true;
    try {
      return await fn();
    } finally {
      this.#running = false;
    }
  }
}
