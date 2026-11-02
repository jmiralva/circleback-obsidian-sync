// What the settings tab does with an account's API key: store it, clear it, and test it. Kept apart
// from the tab (which needs a DOM) so the rules can be tested.
import type { ConnectionInfo } from "../api/schemas";
import type { KeyStore } from "../secrets/keyStore";
import type { DeviceState } from "../state/deviceState";
import { logger } from "../util/logger";
import { checkConnection } from "./settingsView";

interface KeyDeps {
  keys: Pick<KeyStore, "get" | "set" | "clear">;
  device: Pick<DeviceState, "update">;
}

/** How a change to the stored key went: whether this device now has a key, or that it failed (already logged). */
export type KeyChange = { ok: true; hasKey: boolean } | { ok: false };

/**
 * Whether the key field holds something to save: anything but nothing, or only spaces and newlines.
 * The field never clears a key, so it asks this before saving and leaves an empty value alone.
 * Only `clearKey` clears. Backing out of an empty field after "Replace key" asks the same question.
 */
export function hasTypedKey(typed: string): boolean {
  return typed.trim() !== "";
}

/**
 * Stores what the user typed as the account's key, or clears the stored key when it is empty. The
 * key store does not trim, and a pasted key often has a space or newline after it. On success it
 * forgets the cached owner: that belongs to the old key, and a key for someone else must not keep
 * the old person's email, since the engine looks the owner up only when none is cached.
 * Nothing is changed when storing fails.
 */
export function commitKey(deps: KeyDeps, id: string, typed: string): KeyChange {
  const { keys, device } = deps;
  const value = typed.trim();
  try {
    if (value === "") keys.clear(id);
    else keys.set(id, value);
  } catch (error) {
    // The message is about the key store; the typed text is not passed on, so it cannot reach the log.
    logger.error("Could not save the API key.", error);
    return { ok: false };
  }
  device.update(id, { ownerEmail: undefined, ownerName: undefined });
  return { ok: true, hasKey: value !== "" };
}

/** Removes the account's key from this device only. The account and its settings stay. */
export function clearKey(deps: KeyDeps, id: string): KeyChange {
  return commitKey(deps, id, "");
}

/**
 * Tests the account's key and gives the text to show, or null when the answer is out of date: the
 * key changed while the test ran (the email would belong to the old key and be cached for the new
 * one), or `isCurrent` says the tab was closed. A current answer also caches the owner's email.
 */
export async function testKey(
  deps: {
    keys: Pick<KeyStore, "get">;
    device: Pick<DeviceState, "update">;
    clientFor: (key: string) => { testConnection(): Promise<ConnectionInfo> };
  },
  id: string,
  isCurrent: () => boolean,
): Promise<string | null> {
  const { keys, device } = deps;
  const used = keys.get(id);
  // Not passed as `deps.clientFor` itself: it may be a method that needs its object.
  const outcome = await checkConnection(used, (key) => deps.clientFor(key));
  if (!isCurrent() || keys.get(id) !== used) return null;
  if (outcome.email !== undefined) device.update(id, { ownerEmail: outcome.email });
  return outcome.text;
}
