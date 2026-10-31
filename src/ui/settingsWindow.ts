import type { App } from "obsidian";

/** What Obsidian's app object has for the settings window. It is not in the public typings. */
type AppWithSettingWindow = App & { setting?: { close?: () => void } };

// Obsidian 1.11.4 has no public way to close the settings window, and a file opened while it is open
// stays hidden behind it. This does nothing when Obsidian does not have the method.
export function closeSettingsWindow(app: App): void {
  const { setting } = app as AppWithSettingWindow;
  if (typeof setting?.close === "function") setting.close();
}
