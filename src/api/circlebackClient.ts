// The Circleback endpoints the plugin reads, with every response checked against its
// schema. The sync code gets typed data or a `CirclebackError`, never an unchecked body.
//
// A response that fails validation becomes `invalid-response` and nothing from it is used:
// one bad meeting fails its whole page, so a Circleback schema change shows up as an
// error for the account instead of half-written notes.
import * as v from "valibot";
import { FINISHED_STATUSES, SITE_ORIGIN, serializeStatuses } from "./constants";
import { CirclebackError } from "./errors";
import { HttpClient, getHeader } from "./http";
import { ConnectionInfoSchema, MeetingListSchema, TranscriptSchema } from "./schemas";
import type { ConnectionInfo, Meeting, TranscriptSegment } from "./schemas";

export interface MeetingsPage {
  meetings: Meeting[];
  /** The next page's URL, or null on the last page. */
  nextUrl: string | null;
}

export class CirclebackClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** The account's requests per minute once a response has said (see `HttpClient.rateLimit`), else undefined. */
  get rateLimit(): number | undefined {
    return this.#http.rateLimit;
  }

  /** Checks the key. The response carries the account's email, which labels the account. */
  async testConnection(): Promise<ConnectionInfo> {
    const { body } = await this.#http.getJson("/oauth/test");
    return validate(ConnectionInfoSchema, body, "/oauth/test");
  }

  /**
   * One page of meetings. The first page is requested with `ownership` and the finished
   * statuses; later pages pass the previous page's `nextUrl` as `cursorUrl`.
   */
  async listMeetingsPage(opts: { ownership: "Mine" | "All"; cursorUrl?: string }): Promise<MeetingsPage> {
    const { ownership, cursorUrl } = opts;
    const filters = new URLSearchParams(cursorUrl === undefined ? "" : queryOf(cursorUrl));
    const wanted: string[] = [];
    if (!filters.has("ownership")) wanted.push(`ownership=${encodeURIComponent(ownership)}`);
    // The next link may carry only the cursor, so the filters are re-added when it does.
    if (!filters.has("statuses")) {
      const statuses = serializeStatuses(FINISHED_STATUSES);
      if (statuses !== "") wanted.push(statuses);
    }

    const { body, headers } = await this.#http.getJson(cursorUrl ?? "/meetings", wanted.join("&"));
    const meetings = validate(MeetingListSchema, body, "/meetings");
    const next = readNextLink(getHeader(headers, "Link"));
    // Treating a header that cannot be read as "no next page" would end the sync early
    // without a word, and the older meetings would never arrive.
    if (next.kind === "unreadable") {
      throw new CirclebackError(
        "invalid-response",
        "Circleback's answer from /meetings has a Link header that cannot be read, so the next page cannot be found. " +
          "Circleback may have changed its API; look for a plugin update.",
      );
    }
    return { meetings, nextUrl: next.kind === "next" ? next.url : null };
  }

  /**
   * A meeting's transcript, or null when the key may see the meeting but not its
   * transcript (403). Every other failure propagates.
   */
  async getTranscript(meetingId: string): Promise<TranscriptSegment[] | null> {
    const endpoint = `/meeting/${encodeURIComponent(meetingId)}/transcript`;
    let body: unknown;
    try {
      ({ body } = await this.#http.getJson(endpoint));
    } catch (error) {
      if (error instanceof CirclebackError && error.kind === "forbidden") return null;
      throw error;
    }
    // The id is left out of the message; any meeting's transcript has this shape.
    return validate(TranscriptSchema, body, "/meeting/{id}/transcript");
  }
}

/** The query string of a URL, without the `?` and without any fragment. */
function queryOf(url: string): string {
  const withoutFragment = url.split("#")[0];
  const start = withoutFragment.indexOf("?");
  return start === -1 ? "" : withoutFragment.slice(start + 1);
}

/**
 * Checks a response body against its schema. A failure says which endpoint and where the
 * first problem is, and nothing about the content: valibot's own messages quote the
 * offending value, and some keys in a path (insight names) come from the data.
 */
function validate<TSchema extends v.GenericSchema>(
  schema: TSchema,
  body: unknown,
  endpoint: string,
): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, body);
  if (result.success) return result.output;
  throw new CirclebackError(
    "invalid-response",
    `Circleback's answer from ${endpoint} is not in the expected format (first problem: ${describePath(result.issues[0])}). ` +
      "Circleback may have changed its API; look for a plugin update.",
  );
}

/**
 * The field names the response schemas define. A path step with any other name is a key
 * the data chose (the names under `insights`, or an insight's custom fields), so it is
 * hidden from messages.
 */
const SCHEMA_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "name",
  "createdAt",
  "updatedAt",
  "duration",
  "url",
  "tags",
  "attendees",
  "notes",
  "privateNotes",
  "actionItems",
  "insights",
  "sharedWith",
  "profileId",
  "email",
  "title",
  "description",
  "assignee",
  "status",
  "insight",
  "speaker",
  "timestamp",
  "access",
  "text",
  "apiKeyName",
]);

/** Where in the response a problem is, such as `0.tags.1.name`. */
function describePath(issue: v.BaseIssue<unknown>): string {
  const steps = (issue.path ?? []).map((step) => {
    if (typeof step.key === "number") return String(step.key);
    return typeof step.key === "string" && SCHEMA_FIELDS.has(step.key) ? step.key : "*";
  });
  return steps.length === 0 ? "the response as a whole" : steps.join(".");
}

/** One link of a `Link` header: its URL reference and its parameters (names in lower case). */
interface LinkValue {
  target: string;
  params: [name: string, value: string][];
}

/** What a `Link` header says about the next page. */
type NextLink =
  | { kind: "none" } // no header, or a readable one without a next link: the last page
  | { kind: "next"; url: string }
  | { kind: "unreadable" }; // a header that is there but cannot be read, or whose next URL cannot be resolved

function readNextLink(linkHeader: string | undefined): NextLink {
  const links = linkHeader === undefined ? [] : parseLinkHeader(linkHeader);
  if (links === null) return { kind: "unreadable" };
  for (const link of links) {
    // Only the first `rel` counts, and it may list several relation types.
    const rel = link.params.find(([name]) => name === "rel");
    if (rel === undefined || !rel[1].toLowerCase().split(/\s+/).includes("next")) continue;
    try {
      return { kind: "next", url: new URL(link.target, SITE_ORIGIN).href };
    } catch {
      return { kind: "unreadable" };
    }
  }
  return { kind: "none" };
}

/**
 * The URL of the `rel="next"` link in a `Link` header (RFC 8288), as an absolute URL.
 * Relative URLs resolve against the Circleback site. Returns null when the header is
 * missing, has no next link, or cannot be read. `listMeetingsPage` tells the last of
 * those apart from the others, because a header it cannot read must not pass as a last page.
 */
export function parseNextLink(linkHeader: string | undefined): string | null {
  const next = readNextLink(linkHeader);
  return next.kind === "next" ? next.url : null;
}

/** Reads `<url>; name=value; name="value", <url>; ...`. Returns null if any part is malformed. */
function parseLinkHeader(header: string): LinkValue[] | null {
  const links: LinkValue[] = [];
  let at = skipSpace(header, 0);
  while (at < header.length) {
    if (header[at] !== "<") return null;
    const close = header.indexOf(">", at);
    if (close === -1) return null;
    const target = header.slice(at + 1, close).trim();
    if (target === "") return null;
    const link: LinkValue = { target, params: [] };
    links.push(link);

    at = skipSpace(header, close + 1);
    while (header[at] === ";") {
      const param = readParam(header, skipSpace(header, at + 1));
      if (param === null) return null;
      if (param.name !== "") link.params.push([param.name, param.value]);
      at = skipSpace(header, param.end);
    }
    if (at >= header.length) break;
    if (header[at] !== ",") return null;
    // A comma must be followed by another link.
    at = skipSpace(header, at + 1);
    if (at >= header.length) return null;
  }
  return links;
}

/** Reads one `name`, `name=token`, or `name="quoted"` parameter starting at `from`. */
function readParam(text: string, from: number): { name: string; value: string; end: number } | null {
  let at = from;
  while (at < text.length && !";,=".includes(text[at])) at += 1;
  const name = text.slice(from, at).trim().toLowerCase();
  if (text[at] !== "=") return { name, value: "", end: at };

  at = skipSpace(text, at + 1);
  if (text[at] === '"') {
    let value = "";
    at += 1;
    while (at < text.length && text[at] !== '"') {
      if (text[at] === "\\") at += 1; // a quoted pair: take the next character literally
      if (at < text.length) value += text[at];
      at += 1;
    }
    if (at >= text.length) return null; // the closing quote is missing
    return { name, value, end: at + 1 };
  }
  const start = at;
  while (at < text.length && !";,".includes(text[at])) at += 1;
  return { name, value: text.slice(start, at).trim(), end: at };
}

function skipSpace(text: string, from: number): number {
  let at = from;
  while (at < text.length && /\s/.test(text[at])) at += 1;
  return at;
}
