// Which meetings a sync writes, and through which account.
//
// Every function here is pure: it reads the meetings and settings it is given and nothing
// else, so the sync engine (Task 12) can decide what to fetch and write without these
// rules being tangled up with HTTP or the vault.
import { LIST_IS_NEWEST_FIRST, MEETING_START_FIELD } from "../api/constants";
import type { Meeting } from "../api/schemas";
import { meetingTitle } from "../format/fields";
import { ownsMeeting } from "../format/owner";
import type { CirclebackSyncSettings } from "../settings/types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** What one account fetched. `ownerEmail` is the email of the person whose API key the account uses. */
export interface FetchedAccount {
  accountId: string;
  ownerEmail: string;
  meetings: Meeting[];
}

/** The account that writes a meeting, and that account's own copy of it. */
export interface WriterAssignment {
  meeting: Meeting;
  accountId: string;
}

/** When a meeting happened, as a timestamp. The schema guarantees the field parses. */
function startOf(meeting: Meeting): number {
  return Date.parse(meeting[MEETING_START_FIELD]);
}

/**
 * The start of the sync window: `days` days before `now`. A day is 24 hours, not a calendar
 * day, so a daylight saving change inside the window does not move the start.
 */
export function windowStart(now: Date, days: number): Date {
  return new Date(now.getTime() - days * MS_PER_DAY);
}

/**
 * Whether paging can stop: the whole page is older than the window, so (with the list
 * newest first) every later page is older still. A meeting that starts exactly at `start`
 * is in the window.
 *
 * Only meaningful when the list is newest first. Otherwise this is always false and the
 * caller pages through everything. An empty page is false too: it says nothing about the
 * window, and the caller's own end-of-list check (no next page) is what stops on it.
 *
 * `newestFirst` is a parameter, defaulting to the constant the API probe settles, so that
 * both orders can be tested.
 */
export function pageIsPastWindow(page: Meeting[], start: Date, newestFirst: boolean = LIST_IS_NEWEST_FIRST): boolean {
  if (!newestFirst || page.length === 0) return false;
  const cutoff = start.getTime();
  return page.every((meeting) => startOf(meeting) < cutoff);
}

/**
 * Whether a meeting is written by this sync. It must have notes (a meeting still being
 * processed, or one that never got a recording, has `notes: null`; it is picked up on a
 * later run if notes arrive), start inside the window
 * (`start` is null for a full sync, which has no window), and pass the title filter.
 *
 * The filter looks at the title the note shows, so a meeting with no name is "Untitled
 * meeting" to it. The match is a case-insensitive substring match, and an empty keyword
 * filters nothing in either mode.
 */
export function keepMeeting(
  meeting: Meeting,
  settings: Pick<CirclebackSyncSettings, "titleFilterMode" | "titleFilterKeyword">,
  start: Date | null,
): boolean {
  if (meeting.notes === null) return false;
  if (start !== null && startOf(meeting) < start.getTime()) return false;

  const { titleFilterMode, titleFilterKeyword } = settings;
  if (titleFilterMode === "disabled" || titleFilterKeyword === "") return true;
  const matches = meetingTitle(meeting).toLowerCase().includes(titleFilterKeyword.toLowerCase());
  return titleFilterMode === "include" ? matches : !matches;
}

/**
 * Picks one writer for each meeting id across all connected accounts, so a meeting seen
 * through several accounts is written once.
 *
 * `fetched` is in settings order. The account that owns a meeting wins; when none of the
 * accounts that can see it owns it, the first account in order wins. The result holds the
 * chosen account's own copy of the meeting, because the copies can differ (the private
 * notes belong to the key's user).
 *
 * An id seen twice by one account (overlapping pages) counts once, first sighting. If two
 * accounts both claim ownership, which should not happen, the first in order wins.
 */
export function assignWriters(fetched: FetchedAccount[]): Map<string, WriterAssignment> {
  const writers = new Map<string, WriterAssignment>();
  const ownedIds = new Set<string>();

  for (const { accountId, ownerEmail, meetings } of fetched) {
    for (const meeting of meetings) {
      if (ownedIds.has(meeting.id)) continue;
      if (ownsMeeting(meeting, ownerEmail)) {
        writers.set(meeting.id, { meeting, accountId });
        ownedIds.add(meeting.id);
      } else if (!writers.has(meeting.id)) {
        writers.set(meeting.id, { meeting, accountId });
      }
    }
  }
  return writers;
}
