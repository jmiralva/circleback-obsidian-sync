// The edits the settings tab makes to the settings, as pure functions. The tab (settingsTab.ts)
// needs a DOM and cannot be unit-tested, so every decision about what an edit does lives here.
// Each function returns new settings and leaves the ones it was given as they were.
import type { AccountConfig, CirclebackSyncSettings } from "../settings/types";

/** A copy of the settings with one field set. */
export function withField<K extends keyof CirclebackSyncSettings>(
  settings: CirclebackSyncSettings,
  key: K,
  value: CirclebackSyncSettings[K],
): CirclebackSyncSettings {
  return { ...settings, [key]: value };
}

/**
 * Adds an account labelled "Account {n}", where n is the number of accounts plus one, raised
 * until no account already has that label. The first account also turns periodic sync on:
 * it is off until there is something to sync.
 */
export function addAccount(settings: CirclebackSyncSettings, id: string): CirclebackSyncSettings {
  const labels = new Set(settings.accounts.map((account) => account.label));
  let n = settings.accounts.length + 1;
  while (labels.has(`Account ${n}`)) n += 1;
  const account: AccountConfig = { id, label: `Account ${n}`, selfNameOverride: "" };
  return {
    ...settings,
    accounts: [...settings.accounts, account],
    periodicSync: settings.accounts.length === 0 ? true : settings.periodicSync,
  };
}

export function removeAccount(settings: CirclebackSyncSettings, id: string): CirclebackSyncSettings {
  return { ...settings, accounts: settings.accounts.filter((account) => account.id !== id) };
}

/** Changes the label or the name override of one account. An id that is not there changes nothing. */
export function updateAccount(
  settings: CirclebackSyncSettings,
  id: string,
  patch: Partial<Pick<AccountConfig, "label" | "selfNameOverride">>,
): CirclebackSyncSettings {
  return {
    ...settings,
    accounts: settings.accounts.map((account) => (account.id === id ? { ...account, ...patch } : account)),
  };
}

/** A whole number from `min` to `max`, or null for anything else. Only digits count, spaces around them aside. */
export function parseWholeNumber(text: string, min: number, max: number): number | null {
  const trimmed = text.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= min && value <= max ? value : null;
}

/** A folder path as the user typed it, without the spaces and slashes at either end. */
export function trimFolder(text: string): string {
  return text.replace(/^[\s/]+|[\s/]+$/g, "");
}
