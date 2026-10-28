# Test fixtures

Two kinds of fixture live here.

## Hand-written: `schema-*.json`

Written to the shape of the Circleback OpenAPI spec, with obviously fake people and text, before the real API could be probed. They cover edge cases that real data did not have: tags, insights (including custom fields), private notes, sharing entries for groups and workspaces, and a null meeting name.

## Scrubbed from the real API

Captured by the Task 2 probe on 2026-10-27 (GET requests only, one work account) and scrubbed:

| File | Source |
| --- | --- |
| `meetings-page-1.json` | `GET /meetings?ownership=Mine`, first page (20 meetings) |
| `meetings-page-2.json` | the next page, the last one (18 meetings) |
| `meeting.json` | `GET /meeting/{id}` for `probe-meeting-0003`, also on page 1 |
| `transcript.json` | `GET /meeting/{id}/transcript` for `probe-meeting-0003` |
| `oauth-test.json` | `GET /oauth/test` |

### What was replaced

Every value that could identify a person, a company or a meeting was replaced with a deterministic fake:

- Names become `Person A`, `Person B`, and so on. Emails become `person.a@example.com` and so on. Job titles become `Job title N` and companies `Company N`.
- The key owner is `Person A` / `person.a@example.com` everywhere: in attendees, in `sharedWith`, as an action item assignee, as a transcript speaker, and in `oauth-test.json`.
- A name maps to the same fake wherever it appears, so transcript speaker labels still match attendee names.
- Meeting titles become `Meeting N` and meeting ids `probe-meeting-NNNN`.
- Profile, action item and calendar event ids are renumbered.
- Video-call links, recording links, calendar ids and iCalendar UIDs become `example.com` values.
- Notes, action item text and transcript text become lorem ipsum. The notes keep their Markdown structure: `####` headings, `*` bullets, numbering and blank lines. The only text kept is Circleback's template heading `#### Overview`.

### What was kept

- Timestamps, durations, transcript timestamps, statuses and enum values.
- Nulls, empty strings, counts and the order of everything.
- Who owns what.

### How the scrub was checked

The scrub script recorded every original value it replaced. That covers names and their parts, emails and their domains, titles, URLs, ids, and each line of the notes and transcript text. A second script searched these files and this README for each recorded value of 4 or more characters: text values as written and JSON-escaped, single words case-insensitively as whole words, and ids as whole numbers. It found no matches. A plain search for the account's company, its owner, and personal email domains found none either.

### What else the real responses carried

These notes cover parts of the responses the fixture files leave out:

- Page 1 had the header `Link: </api/meetings?ownership=Mine&cursor=eyJwYWdlIjoxfQ>; rel="next"`. The link is relative to `https://circleback.ai`, repeats the query that was sent, and adds a cursor. The last page has no `Link` header.
- Rate limit headers describe one window at a time, whichever is closer to running out:
  - The per-second window: `RateLimit-Limit: 3`, `RateLimit-Remaining: 2`, `RateLimit-Reset: 1`.
  - The per-minute window, for example: `20`, `13`, `24`.
  - `RateLimit-Reset` is in seconds.
- A bad key gets `401` with `{"error":"The provided API key is invalid."}` and no rate limit headers.
- A meeting without notes has no transcript, and the transcript request gets `404` with `{"error":"Transcript not found for meeting <id>."}`.
- The schemas ignore some fields the real responses carry: `recordingUrl`, `icalUid`, `linkAccess`, `calendarEvent`, attendee `title`, `companyName`, `isCalendarInvitee` and `isCalendarEventOrganizer`, and the extra assignee and `sharedWith` fields. They are kept here as they came, after the scrub.
