// The body of a meeting's note: private notes, Circleback's notes, action items, insights, and a link back.
import { NOTES_HAVE_ACTION_ITEMS, circlebackUrl } from "../api/constants";
import type { ActionItem, InsightEntry, Meeting } from "../api/schemas";

export interface NoteBodyOptions {
  includePrivateNotes: boolean;
  includeActionItems: boolean;
  includeInsights: boolean;
}

/**
 * Text for one list item. Surrounding whitespace goes, and the lines after the first are
 * indented two spaces so that a multi-line description stays inside its bullet.
 */
function itemText(text: string): string {
  return text.trim().replace(/\r?\n/g, "\n  ");
}

function nonBlank(text: string | null | undefined): string | null {
  return text !== null && text !== undefined && text.trim() !== "" ? text.trim() : null;
}

/** `- {title} ({assignee}): {description}`, with ` (done)` after it when finished. A plain bullet, not a checkbox. */
function actionItemLine(item: ActionItem): string {
  const assignee = nonBlank(item.assignee?.name) ?? nonBlank(item.assignee?.email) ?? "unassigned";
  const description = item.description.trim();
  const detail = description === "" ? "" : `: ${itemText(description)}`;
  const done = item.status === "DONE" ? " (done)" : "";
  return `- ${itemText(item.title)} (${assignee})${detail}${done}`;
}

// A value inside an object-valued insight. The schema allows text, numbers, booleans and null.
function valueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * An insight as one line of text. An insight with custom fields arrives as an object, shown
 * as `Field: value` pairs joined by commas, with the empty fields left out.
 */
function insightText(entry: InsightEntry): string {
  const { insight } = entry;
  if (typeof insight === "string") return insight.trim();
  return Object.entries(insight)
    .map(([field, value]) => ({ field, text: valueText(value) }))
    .filter(({ text }) => text !== "")
    .map(({ field, text }) => `${field}: ${text}`)
    .join(", ");
}

function insightBlocks(insights: Meeting["insights"]): string[] {
  const blocks: string[] = [];
  for (const [name, entries] of Object.entries(insights)) {
    const bullets = entries
      .map(insightText)
      .filter((text) => text !== "")
      .map((text) => `- ${itemText(text)}`);
    if (bullets.length > 0) blocks.push(`### ${name.trim()}\n\n${bullets.join("\n")}`);
  }
  return blocks;
}

/**
 * Builds a note's body. Sections come in this order, each only when it has something to say,
 * separated by one blank line:
 *
 * 1. `## Private Notes`, then `## Enhanced Notes` above Circleback's notes (only with private notes included and non-empty).
 * 2. Circleback's notes.
 * 3. `## Action Items`, unless Circleback's notes already have an action items heading.
 * 4. `## Insights`, with a `###` heading per insight.
 * 5. `View in Circleback: <link>`, always.
 */
export function buildNoteBody(meeting: Meeting, options: NoteBodyOptions): string {
  const notes = (meeting.notes ?? "").trim();
  const privateNotes = meeting.privateNotes.trim();
  const sections: string[] = [];

  if (options.includePrivateNotes && privateNotes !== "") {
    sections.push(`## Private Notes\n\n${privateNotes}`);
    if (notes !== "") sections.push(`## Enhanced Notes\n\n${notes}`);
  } else if (notes !== "") {
    sections.push(notes);
  }

  if (options.includeActionItems && meeting.actionItems.length > 0 && !NOTES_HAVE_ACTION_ITEMS.test(notes)) {
    sections.push(`## Action Items\n\n${meeting.actionItems.map(actionItemLine).join("\n")}`);
  }

  if (options.includeInsights) {
    const blocks = insightBlocks(meeting.insights);
    if (blocks.length > 0) sections.push(`## Insights\n\n${blocks.join("\n\n")}`);
  }

  sections.push(`View in Circleback: ${circlebackUrl(meeting.id)}`);
  return `${sections.join("\n\n")}\n`;
}
