// Facts about the Circleback API that the rest of the plugin relies on.
//
// The base URLs are final. Every value marked PROVISIONAL is a conservative guess made
// before the real API could be probed: Task 2's probe confirms or replaces it, and the
// plugin works correctly (if less efficiently) with the guess.
import type { Meeting } from "./schemas";

/** Base URL for every request. A meeting's Circleback link is `${SITE_ORIGIN}/meetings/{id}`. */
export const API_BASE = "https://circleback.ai/api";

/** The origin that relative `Link` header URLs resolve against. */
export const SITE_ORIGIN = "https://circleback.ai";

// PROVISIONAL: confirm with the Task 2 API probe
/**
 * The `statuses` filter that limits the list to finished meetings. The OpenAPI spec gives
 * no list of statuses and the meeting object has no status field, so no filter is sent.
 */
export const FINISHED_STATUSES: string[] = [];

// PROVISIONAL: confirm with the Task 2 API probe
/** Query string for the `statuses` filter: repeated keys, URL-encoded. Empty for no filter. */
export function serializeStatuses(statuses: string[]): string {
  return statuses.map((status) => `statuses=${encodeURIComponent(status)}`).join("&");
}

// PROVISIONAL: confirm with the Task 2 API probe
/** Whether `GET /meetings` returns the newest meeting first. False means "page through everything". */
export const LIST_IS_NEWEST_FIRST = false;

type StringFieldOfMeeting = {
  [K in keyof Meeting]-?: Meeting[K] extends string ? K : never;
}[keyof Meeting];

/** The fields of a meeting that hold a timestamp, which are the ones that can mark its start. */
export type MeetingStartField = Extract<StringFieldOfMeeting, "createdAt" | "updatedAt">;

// PROVISIONAL: confirm with the Task 2 API probe
/**
 * The field that says when a meeting happened. The list has no date filter, so this decides the sync window.
 *
 * `satisfies` rather than a `: MeetingStartField` annotation, so that `typeof MEETING_START_FIELD` is the one
 * field named here and not the whole union. Types built from it (`Pick<Meeting, typeof MEETING_START_FIELD>`)
 * then ask for that field only, and switching the value breaks every place that hard-codes the old one.
 */
export const MEETING_START_FIELD = "createdAt" satisfies MeetingStartField;

// PROVISIONAL: confirm with the Task 2 API probe
/** Statuses that mean the key is wrong or revoked, as opposed to "not allowed to see this" (403). */
export const AUTH_ERROR_STATUSES: number[] = [401];

// PROVISIONAL: confirm with the Task 2 API probe
/** Matches an "Action Items" heading in a meeting's Markdown notes. */
export const NOTES_HAVE_ACTION_ITEMS = /^#{1,6}\s+action items\s*$/im;
