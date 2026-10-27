// Types and validators for what the Circleback API returns.
//
// Each type below is what the rest of the plugin reads. Each schema checks the wire shape
// from the OpenAPI spec and keeps only the fields in its type: unknown fields are allowed
// and dropped, so a Circleback release that adds a field does not break syncing, while a
// missing or wrongly typed field fails the whole page (reported as `invalid-response`).
//
// The schemas are annotated with the plain types, so the compiler checks that a schema
// produces everything its type promises.
import * as v from "valibot";

export interface Attendee {
  profileId: number;
  name: string | null;
  email: string | null;
}

export interface ActionItem {
  id: number;
  title: string;
  description: string;
  assignee: { name: string | null; email: string | null } | null;
  status: "PENDING" | "DONE";
}

export interface InsightEntry {
  insight: string | Record<string, unknown>;
  speaker: string | null;
  timestamp: number | null;
}

export interface SharedEntry {
  name: string | null;
  email?: string | null;
  access: "Owner" | "Editor" | "Viewer" | "LimitedViewer";
}

export interface Meeting {
  id: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  /** Seconds. */
  duration: number | null;
  /** The video-call link (Zoom, Meet, Teams), not a Circleback link. */
  url: string | null;
  tags: { id: number; name: string }[];
  attendees: Attendee[];
  notes: string | null;
  privateNotes: string;
  actionItems: ActionItem[];
  insights: Record<string, InsightEntry[]>;
  sharedWith: SharedEntry[];
}

export interface TranscriptSegment {
  speaker: string | null;
  text: string;
  /** Seconds from the start of the meeting. */
  timestamp: number;
}

export interface ConnectionInfo {
  email: string;
  apiKeyName?: string;
}

// A timestamp the rest of the plugin can turn into a date. Anything `Date` cannot read
// would otherwise reach file names and daily-note lookups as "Invalid date".
const TimestampSchema = v.pipe(
  v.string(),
  v.check((value) => !Number.isNaN(Date.parse(value)), "Invalid timestamp"),
);

export const AttendeeSchema: v.GenericSchema<unknown, Attendee> = v.object({
  profileId: v.number(),
  name: v.nullable(v.string()),
  email: v.nullable(v.string()),
});

export const ActionItemSchema: v.GenericSchema<unknown, ActionItem> = v.object({
  id: v.number(),
  title: v.string(),
  description: v.string(),
  assignee: v.nullable(
    v.object({
      name: v.nullable(v.string()),
      email: v.nullable(v.string()),
    }),
  ),
  status: v.picklist(["PENDING", "DONE"]),
});

// The API allows an object of scalar fields when the insight has custom fields.
export const InsightEntrySchema: v.GenericSchema<unknown, InsightEntry> = v.object({
  insight: v.union([
    v.string(),
    v.record(v.string(), v.union([v.string(), v.number(), v.boolean(), v.null()])),
  ]),
  speaker: v.nullable(v.string()),
  timestamp: v.nullable(v.number()),
});

// The API returns people, teams, and workspaces here. One shape covers all three: teams
// and workspaces have no email, and their ids are dropped with the other unknown fields.
export const SharedEntrySchema: v.GenericSchema<unknown, SharedEntry> = v.object({
  name: v.nullable(v.string()),
  email: v.optional(v.nullable(v.string())),
  access: v.picklist(["Owner", "Editor", "Viewer", "LimitedViewer"]),
});

export const MeetingSchema: v.GenericSchema<unknown, Meeting> = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  name: v.nullable(v.string()),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  duration: v.nullable(v.number()),
  url: v.nullable(v.string()),
  tags: v.array(v.object({ id: v.number(), name: v.string() })),
  attendees: v.array(AttendeeSchema),
  notes: v.nullable(v.string()),
  privateNotes: v.string(),
  actionItems: v.array(ActionItemSchema),
  insights: v.record(v.string(), v.array(InsightEntrySchema)),
  sharedWith: v.array(SharedEntrySchema),
});

/** One page of `GET /meetings`. */
export const MeetingListSchema = v.array(MeetingSchema);

export const TranscriptSegmentSchema: v.GenericSchema<unknown, TranscriptSegment> = v.object({
  speaker: v.nullable(v.string()),
  text: v.string(),
  timestamp: v.number(),
});

/** The response of `GET /meeting/{id}/transcript`. */
export const TranscriptSchema = v.array(TranscriptSegmentSchema);

/** The response of `GET /oauth/test`. */
export const ConnectionInfoSchema: v.GenericSchema<unknown, ConnectionInfo> = v.object({
  email: v.string(),
  apiKeyName: v.optional(v.string()),
});
