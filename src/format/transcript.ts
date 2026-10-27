// A meeting's transcript as Markdown: one block per run of consecutive segments by the same speaker.
import type { TranscriptSegment } from "../api/schemas";

const GUEST_LABEL = "Guest";

/**
 * Formats a transcript:
 *
 *     # Transcript for: {title}
 *
 *     ### {speaker} ({ISO time})
 *
 *     {the run's segments, joined with single spaces}
 *
 * Each block's time is the meeting's start plus the offset of the run's first segment, as a
 * UTC ISO string. A segment with no speaker (or a blank one) is "Guest". A speaker equal to
 * `selfName`, ignoring case and surrounding spaces, gets `selfLabel`; a null `selfName`
 * means the owner's name is not known, so nobody is relabelled. Runs are decided on the
 * final label, so the owner's name written two ways stays one run, and so do a null speaker
 * and one literally called "Guest". Segments with no text are left out.
 *
 * Built with arrays and one join, so a very long meeting (10,000 segments) is quick.
 */
export function buildTranscriptBody(
  title: string,
  segs: TranscriptSegment[],
  startIso: string,
  selfName: string | null,
  selfLabel: string,
): string {
  const self = selfName === null ? "" : selfName.trim().toLowerCase();
  const startMs = Date.parse(startIso);

  // A title with a line break would leave the rest of it outside the heading.
  const lines: string[] = [`# Transcript for: ${title.replace(/\s+/g, " ").trim()}`, ""];
  let label: string | null = null;
  let runStart = "";
  let words: string[] = [];

  const endRun = (): void => {
    if (label === null) return;
    lines.push(`### ${label} (${runStart})`, "", words.join(" "), "");
  };

  for (const seg of segs) {
    const text = seg.text.trim();
    if (text === "") continue;

    const name = seg.speaker === null ? "" : seg.speaker.trim();
    let segLabel = name;
    if (name === "") segLabel = GUEST_LABEL;
    else if (self !== "" && name.toLowerCase() === self) segLabel = selfLabel;

    if (segLabel !== label) {
      endRun();
      label = segLabel;
      runStart = new Date(startMs + seg.timestamp * 1000).toISOString();
      words = [];
    }
    words.push(text);
  }
  endRun();

  return `${lines.join("\n")}\n`;
}
