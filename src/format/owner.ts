// Finding the key owner (the person whose API key an account uses) in a meeting.
//
// The account's email is known from the connection test. The meeting lists people twice:
// in `attendees` (who was there) and in `sharedWith` (who may open it). The owner appears
// in one or both, and the match is by email.
import type { Meeting } from "../api/schemas";

export interface OwnerInfo {
  name: string | null;
  /** Only known when the owner is found among the attendees. */
  profileId?: number;
}

function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/**
 * Whether two emails are the same address, ignoring case and surrounding spaces. A missing
 * or empty email never matches, so an attendee with no email is not mistaken for an owner
 * whose email is not known.
 */
export function emailsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeEmail(a);
  return left !== "" && left === normalizeEmail(b);
}

/**
 * The owner's entry in a meeting: the attendee with that email, else the `sharedWith` entry
 * with it. Null when `ownerEmail` is empty or nobody has it.
 */
export function findOwner(meeting: Meeting, ownerEmail: string): OwnerInfo | null {
  const attendee = meeting.attendees.find((a) => emailsMatch(a.email, ownerEmail));
  if (attendee) return { name: attendee.name, profileId: attendee.profileId };
  const shared = meeting.sharedWith.find((entry) => emailsMatch(entry.email, ownerEmail));
  if (shared) return { name: shared.name };
  return null;
}

/** Whether the `sharedWith` entry with `access: "Owner"` has this email, so this account's person owns the meeting. */
export function ownsMeeting(meeting: Meeting, ownerEmail: string): boolean {
  return meeting.sharedWith.some((entry) => entry.access === "Owner" && emailsMatch(entry.email, ownerEmail));
}
