// The frontmatter the plugin writes for a note or a transcript.
//
// This builds the values only. Writing them goes through `processFrontMatter` (Task 10),
// which removes a plugin-owned key that is absent from the result, so a key left out here
// (`meeting_url` for a meeting with no video link) disappears from a note that had it.
//
// Never produced here: `type` and `circleback_first_synced`, which are set once, when the
// file is created.
import { MEETING_START_FIELD, circlebackUrl } from "../api/constants";
import type { Meeting } from "../api/schemas";
import { emailsMatch } from "./owner";
import { FALLBACK_TITLE } from "./paths";

export type FileKind = "note" | "transcript" | "combined";

export interface FieldsContext {
  accountLabel: string;
  /** The account's email, to keep its owner out of the attendees. May be empty when unknown. */
  ownerEmail: string;
  kind: FileKind;
  /** Vault path (with `.md`) of the file on the other side: the transcript for a note, the note for a transcript. */
  linkTo?: string;
  /** Hash of the body being written. */
  hash: string;
}

/**
 * The meeting's title as it is written to the `title` field and the transcript heading:
 * the name as Circleback has it, or "Untitled meeting" when it has none. It is not
 * sanitized, because Task 10 runs it through `sanitizeTitle` to find where the file was
 * put under the previous title.
 */
export function meetingTitle(meeting: Pick<Meeting, "name">): string {
  return meeting.name !== null && meeting.name.trim() !== "" ? meeting.name : FALLBACK_TITLE;
}

/** The attendees of a meeting without the owner: names (else emails) and, separately, emails. */
function attendeeFields(meeting: Meeting, ownerEmail: string): { attendees: string[]; attendee_emails: string[] } {
  const attendees: string[] = [];
  const attendeeEmails: string[] = [];
  for (const attendee of meeting.attendees) {
    if (emailsMatch(attendee.email, ownerEmail)) continue;
    const name = attendee.name === null ? "" : attendee.name.trim();
    const email = attendee.email === null ? "" : attendee.email.trim();
    if (email !== "") attendeeEmails.push(email);
    if (name !== "") attendees.push(name);
    else if (email !== "") attendees.push(email);
  }
  return { attendees, attendee_emails: attendeeEmails };
}

/**
 * The frontmatter for one file of a meeting.
 *
 * Notes (and combined notes) get `attendees` and `attendee_emails`; transcripts do not.
 * `duration` is in minutes: the API gives seconds. The link to the other file is a wikilink
 * under `transcript` on a note and `note` on a transcript, and is left out without `linkTo`.
 */
export function buildFields(meeting: Meeting, ctx: FieldsContext): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    title: meetingTitle(meeting),
    created: meeting[MEETING_START_FIELD],
    duration: meeting.duration === null ? null : Math.round(meeting.duration / 60),
  };

  if (ctx.kind !== "transcript") Object.assign(fields, attendeeFields(meeting, ctx.ownerEmail));

  fields.circleback_tags = meeting.tags.map((tag) => tag.name);

  const videoUrl = meeting.url === null ? "" : meeting.url.trim();
  if (videoUrl !== "") fields.meeting_url = videoUrl;

  if (ctx.linkTo) fields[ctx.kind === "transcript" ? "note" : "transcript"] = `[[${ctx.linkTo}]]`;

  fields.circleback_id = meeting.id;
  fields.circleback_kind = ctx.kind;
  fields.circleback_account = ctx.accountLabel;
  fields.circleback_updated = meeting.updatedAt;
  fields.circleback_hash = ctx.hash;
  fields.circleback_url = circlebackUrl(meeting.id);
  return fields;
}
