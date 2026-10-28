// Timer functions for tests that use jest's fake timers. They look up the global timers on each
// call, so they follow `jest.useFakeTimers()`, and they stand in for `window.setTimeout`.
import type { Timers } from "../../src/util/timers";

export const jestTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
};
