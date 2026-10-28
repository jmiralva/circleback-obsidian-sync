// The jest stand-in for Obsidian's `debounce` has to behave as the real one does, since the
// settings saver's tests rely on it. These tests pin the parts they rely on.
import { debounce } from "../__mocks__/obsidian";

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("mock debounce", () => {
  it("calls the function once, after the wait, with the latest arguments", () => {
    const cb = jest.fn();
    const debounced = debounce(cb, 500, true);

    debounced("a");
    debounced("b");
    jest.advanceTimersByTime(499);
    expect(cb).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("b");
  });

  it("restarts the wait on each call when resetTimer is true", () => {
    const cb = jest.fn();
    const debounced = debounce(cb, 500, true);

    debounced();
    jest.advanceTimersByTime(400);
    debounced();
    jest.advanceTimersByTime(400);
    expect(cb).not.toHaveBeenCalled();

    jest.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("keeps the first wait when resetTimer is false", () => {
    const cb = jest.fn();
    const debounced = debounce(cb, 500, false);

    debounced("a");
    jest.advanceTimersByTime(400);
    debounced("b");
    jest.advanceTimersByTime(100);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("b");
  });

  it("can be used again after it has fired", () => {
    const cb = jest.fn();
    const debounced = debounce(cb, 100, true);

    debounced();
    jest.advanceTimersByTime(100);
    debounced();
    jest.advanceTimersByTime(100);

    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("returns itself, so calls can be chained", () => {
    const debounced = debounce(jest.fn(), 100, true);

    expect(debounced()).toBe(debounced);
  });

  describe("run", () => {
    it("calls the pending function at once and clears the wait", () => {
      const cb = jest.fn((_value: string) => 42);
      const debounced = debounce(cb, 500, true);
      debounced("x");

      const result = debounced.run();

      expect(result).toBe(42);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith("x");
      jest.advanceTimersByTime(1000);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("does nothing when no call is pending", () => {
      const cb = jest.fn();
      const debounced = debounce(cb, 500, true);

      expect(debounced.run()).toBeUndefined();
      expect(cb).not.toHaveBeenCalled();
    });

    it("does nothing a second time", () => {
      const cb = jest.fn();
      const debounced = debounce(cb, 500, true);
      debounced();

      debounced.run();
      debounced.run();

      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe("cancel", () => {
    it("drops the pending call", () => {
      const cb = jest.fn();
      const debounced = debounce(cb, 500, true);
      debounced();

      debounced.cancel();
      jest.advanceTimersByTime(1000);

      expect(cb).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it("leaves nothing for run to call", () => {
      const cb = jest.fn();
      const debounced = debounce(cb, 500, true);
      debounced();
      debounced.cancel();

      debounced.run();

      expect(cb).not.toHaveBeenCalled();
    });

    it("lets the function be scheduled again", () => {
      const cb = jest.fn();
      const debounced = debounce(cb, 500, true);
      debounced();
      debounced.cancel();

      debounced();
      jest.advanceTimersByTime(500);

      expect(cb).toHaveBeenCalledTimes(1);
    });
  });
});
