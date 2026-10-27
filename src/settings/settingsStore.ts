import type { Plugin } from "obsidian";
import { logger } from "../util/logger";
import { DEFAULT_SETTINGS } from "./types";
import type { AccountConfig, CirclebackSyncSettings } from "./types";

type Listener = (settings: CirclebackSyncSettings) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Settings are plain JSON, so a JSON round trip is a deep copy.
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// A stored value is usable only when it has the same kind as the default (string, number,
// boolean or list). Anything else, such as a hand-edited "soon" for a number, falls back.
function sameKind(stored: unknown, fallback: unknown): boolean {
  return typeof stored === typeof fallback && Array.isArray(stored) === Array.isArray(fallback);
}

function cleanAccounts(raw: unknown): AccountConfig[] {
  if (!Array.isArray(raw)) return [];
  const accounts: AccountConfig[] = [];
  for (const entry of raw as unknown[]) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id === "") continue;
    accounts.push({
      ...entry,
      id: entry.id,
      label: typeof entry.label === "string" ? entry.label : "",
      selfNameOverride: typeof entry.selfNameOverride === "string" ? entry.selfNameOverride : "",
    });
  }
  return accounts;
}

// Whatever data.json held, as a complete settings object that shares nothing with
// DEFAULT_SETTINGS or with the loaded data. Keys this version does not know are kept, so an
// older copy of the plugin does not erase settings a newer one added.
function withDefaults(raw: unknown): CirclebackSyncSettings {
  const stored = isRecord(raw) ? clone(raw) : {};
  const result: Record<string, unknown> = { ...stored };
  for (const [key, fallback] of Object.entries(clone(DEFAULT_SETTINGS))) {
    if (!sameKind(stored[key], fallback)) result[key] = fallback;
  }
  result.accounts = cleanAccounts(stored.accounts);
  return result as unknown as CirclebackSyncSettings;
}

/**
 * The plugin's settings, kept in data.json.
 *
 * data.json holds only settings, and `save` writes it only when the user edits them. Loading
 * and reloading never write, so a stale copy on one device cannot overwrite newer settings
 * from another.
 */
export class SettingsStore {
  current: CirclebackSyncSettings = clone(DEFAULT_SETTINGS);
  private readonly listeners: Listener[] = [];

  constructor(private readonly plugin: Plugin) {}

  async load(): Promise<CirclebackSyncSettings> {
    this.current = withDefaults(await this.plugin.loadData());
    return this.current;
  }

  /** Writes data.json. Call it only for edits the user made. */
  async save(next: CirclebackSyncSettings): Promise<void> {
    const snapshot = clone(next);
    await this.plugin.saveData(snapshot);
    this.current = snapshot;
    this.notify();
  }

  /** Re-reads data.json after another device changed it (`onExternalSettingsChange`). */
  async reloadFromDisk(): Promise<CirclebackSyncSettings> {
    await this.load();
    this.notify();
    return this.current;
  }

  /** Runs after every `save` and `reloadFromDisk`. */
  onChange(cb: Listener): void {
    this.listeners.push(cb);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.current);
      } catch (error) {
        // The settings are already saved; one broken listener must not hide that or starve the rest.
        logger.error("A settings change listener failed", error);
      }
    }
  }
}
