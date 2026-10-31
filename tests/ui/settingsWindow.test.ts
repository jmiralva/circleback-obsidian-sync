import type { App } from "obsidian";
import { closeSettingsWindow } from "../../src/ui/settingsWindow";

describe("closeSettingsWindow", () => {
  it("closes the settings window when Obsidian has one", () => {
    const close = jest.fn();
    closeSettingsWindow({ setting: { close } } as unknown as App);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("calls close on the settings object, which needs its own state", () => {
    const setting = {
      closed: false,
      close(): void {
        this.closed = true;
      },
    };
    closeSettingsWindow({ setting } as unknown as App);
    expect(setting.closed).toBe(true);
  });

  it("does nothing when Obsidian has no settings object", () => {
    expect(() => closeSettingsWindow({} as unknown as App)).not.toThrow();
  });

  it("does nothing when the settings object has no close method", () => {
    expect(() => closeSettingsWindow({ setting: {} } as unknown as App)).not.toThrow();
    expect(() => closeSettingsWindow({ setting: { close: "not a function" } } as unknown as App)).not.toThrow();
  });
});
