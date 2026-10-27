import type { App } from "obsidian";

const SECRET_ID_PREFIX = "circleback-sync-";

/**
 * API keys, one per account, in Obsidian's secret storage.
 *
 * Secret storage is encrypted and local to this device and vault, so keys never reach
 * data.json, the vault, or a sync service. The id is fixed per account
 * (`circleback-sync-<account-uuid>`); Obsidian accepts ids that match `^[a-z0-9-]+$` and
 * are at most 64 characters, which a lowercase UUID meets.
 */
export class KeyStore {
  constructor(private readonly app: App) {}

  secretId(accountId: string): string {
    return `${SECRET_ID_PREFIX}${accountId}`;
  }

  /** The account's key, or null when none is stored on this device. */
  get(accountId: string): string | null {
    const key = this.app.secretStorage.getSecret(this.secretId(accountId));
    return key ? key : null;
  }

  set(accountId: string, key: string): void {
    this.app.secretStorage.setSecret(this.secretId(accountId), key);
  }

  /** Obsidian 1.11.4 has no way to delete a secret, so this stores an empty one, which reads as null. */
  clear(accountId: string): void {
    this.app.secretStorage.setSecret(this.secretId(accountId), "");
  }
}
