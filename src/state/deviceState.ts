import type { App } from "obsidian";

const STORAGE_KEY = "circleback-sync-device-state";

/** What this device knows about one account. None of it is shared with other devices. */
export interface AccountDeviceState {
  /** When this device last synced the account without error (ISO time). */
  lastSuccessAt?: string;
  lastError?: string;
  /** True from the first failing run until the next success. Drives the "stopped syncing" notice. */
  failing?: boolean;
  ownerEmail?: string;
  ownerName?: string;
  /** The account's latest `RateLimit-Limit`: its per-second or per-minute limit, whichever the last response reported. */
  rateLimit?: number;
  /** Where a full sync stopped, so it can resume after a restart. */
  fullSyncCursor?: string | null;
  fullSyncActive?: boolean;
  /** Meeting id -> the `updatedAt` at which its transcript returned 403. */
  forbiddenTranscripts?: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Device-local state, in one JSON blob under `circleback-sync-device-state`.
 *
 * It uses `app.saveLocalStorage` (per vault, per device) and never data.json, so a vault sync
 * service cannot carry one device's sync times, cursors or toggle over to another.
 */
export class DeviceState {
  private syncOn = true;
  private readonly accounts: Record<string, AccountDeviceState> = {};

  constructor(private readonly app: App) {
    const stored: unknown = app.loadLocalStorage(STORAGE_KEY);
    if (!isRecord(stored)) return;
    if (typeof stored.syncOnThisDevice === "boolean") this.syncOn = stored.syncOnThisDevice;
    if (!isRecord(stored.accounts)) return;
    for (const [id, state] of Object.entries(stored.accounts)) {
      if (isRecord(state)) this.accounts[id] = clone(state);
    }
  }

  /** On by default. Turn it off to keep one device of a shared vault from syncing. */
  get syncOnThisDevice(): boolean {
    return this.syncOn;
  }

  set syncOnThisDevice(on: boolean) {
    this.syncOn = on;
    this.persist();
  }

  /** A copy of the account's state; empty for an account this device has not seen. */
  account(id: string): AccountDeviceState {
    return clone(this.accounts[id] ?? {});
  }

  /** Merges the patch into the account's state. A field set to `undefined` is removed. */
  update(id: string, patch: Partial<AccountDeviceState>): void {
    const next: Record<string, unknown> = { ...this.accounts[id] };
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) delete next[field];
      else next[field] = clone(value);
    }
    this.accounts[id] = next;
    this.persist();
  }

  private persist(): void {
    this.app.saveLocalStorage(STORAGE_KEY, { syncOnThisDevice: this.syncOn, accounts: this.accounts });
  }
}
