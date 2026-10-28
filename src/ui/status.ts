// The text of the status bar item: each account's last sync, its error, or full-sync progress.
import { moment } from "obsidian";
import type { AccountDeviceState } from "../state/deviceState";

/** An account as the status bar sees it: its state on this device, its name, and whether it has a key here. */
export type StatusAccount = AccountDeviceState & { label: string; hasKey: boolean };

/** What the status bar says when "Sync on this device" is off. */
export const SYNC_OFF_TEXT = "Circleback: off on this device";

/** One account's part of the text. */
function accountPart(account: StatusAccount, now: Date): string {
  if (!account.hasKey) return `${account.label} key needed on this device`;
  if (account.failing === true) return `${account.label} error`;
  if (account.lastSuccessAt !== undefined) {
    // Local time, as everything the user sees is.
    const last = moment.utc(new Date(account.lastSuccessAt)).local();
    if (last.isValid()) {
      const today = moment.utc(now.getTime()).local();
      return `${account.label} ${last.isSame(today, "day") ? last.format("HH:mm") : last.format("MMM D")}`;
    }
  }
  return `${account.label} not synced yet`;
}

/**
 * The status bar text, for example `Circleback: Work 10:42, Personal error`. Empty when there are
 * no accounts, so the item can be hidden. `now` says which day is "today".
 */
export function statusText(
  perAccount: Record<string, StatusAccount>,
  fullSync?: { done: number },
  now: Date = new Date(),
): string {
  const accounts = Object.values(perAccount);
  if (accounts.length === 0) return "";
  if (fullSync !== undefined) return `Circleback: full sync ${fullSync.done}`;
  return `Circleback: ${accounts.map((account) => accountPart(account, now)).join(", ")}`;
}
