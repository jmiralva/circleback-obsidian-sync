// The two timer functions that the scheduler and the readiness gate need, passed in so tests can
// fake time. The plugin passes `window.setTimeout` and `window.clearTimeout`, which use numbers
// as handles.

export interface Timers {
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}
