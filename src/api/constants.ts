// Facts about the Circleback API that the rest of the plugin relies on.
//
// The values come from probing the real API on 2026-10-27 (Task 2). Two are still marked
// PROVISIONAL, each with the reason: the probe could not settle them, and the plugin works
// correctly without them.
import type { Meeting } from "./schemas";

/** Base URL for every request. A meeting's Circleback link is `${SITE_ORIGIN}/meetings/{id}`. */
export const API_BASE = "https://circleback.ai/api";

/** The origin that relative `Link` header URLs resolve against. */
export const SITE_ORIGIN = "https://circleback.ai";

/** The meeting's page on Circleback. Not `meeting.url`, which is the video-call link. */
export function circlebackUrl(meetingId: string): string {
  return `${SITE_ORIGIN}/meetings/${meetingId}`;
}

// PROVISIONAL: no status value could be found. The API docs list none, and every value the
// probe tried (and nonsense ones) came back with the unfiltered list, so the filter has no
// visible effect. The plugin skips meetings whose `notes` are null instead.
/** The `statuses` filter that limits the list to finished meetings. Empty: no filter is sent. */
export const FINISHED_STATUSES: string[] = [];

// PROVISIONAL: the server accepts repeated keys, `statuses[]=` and comma-separated values
// alike, and the next-page link repeats the filter in the form it was sent. Which form it
// reads cannot be told while no value filters anything. Repeated keys are the OpenAPI default.
/** Query string for the `statuses` filter: repeated keys, URL-encoded. Empty for no filter. */
export function serializeStatuses(statuses: string[]): string {
  return statuses.map((status) => `statuses=${encodeURIComponent(status)}`).join("&");
}

/**
 * Whether `GET /meetings` returns the newest meeting first. It does: `createdAt` never
 * increases from one meeting to the next, within a page or across pages.
 */
export const LIST_IS_NEWEST_FIRST = true;

type StringFieldOfMeeting = {
  [K in keyof Meeting]-?: Meeting[K] extends string ? K : never;
}[keyof Meeting];

/** The fields of a meeting that hold a timestamp, which are the ones that can mark its start. */
export type MeetingStartField = Extract<StringFieldOfMeeting, "createdAt" | "updatedAt">;

/**
 * The field that says when a meeting happened. The list has no date filter, so this decides the sync window.
 *
 * `createdAt` is when Circleback started recording: usually a minute or two after the calendar
 * start, and the moment transcript timestamps count from.
 *
 * `satisfies` rather than a `: MeetingStartField` annotation, so that `typeof MEETING_START_FIELD` is the one
 * field named here and not the whole union. Types built from it (`Pick<Meeting, typeof MEETING_START_FIELD>`)
 * then ask for that field only, and switching the value breaks every place that hard-codes the old one.
 */
export const MEETING_START_FIELD = "createdAt" satisfies MeetingStartField;

/**
 * Statuses that mean the key is wrong or revoked, as opposed to "not allowed to see this" (403).
 * An invalid key gets 401 with `{"error":"The provided API key is invalid."}`.
 */
export const AUTH_ERROR_STATUSES: number[] = [401];

/**
 * Matches an action items section in a meeting's Markdown notes, so the plugin does not add a
 * second one. Circleback's notes have none (an "Overview" and topic headings only; action items
 * come in `actionItems`), so this never matches and the plugin's own section is always added.
 */
export const NOTES_HAVE_ACTION_ITEMS = /(?!)/;
