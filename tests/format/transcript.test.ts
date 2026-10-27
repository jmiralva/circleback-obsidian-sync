import type { TranscriptSegment } from "../../src/api/schemas";
import { buildTranscriptBody } from "../../src/format/transcript";

const START = "2026-10-20T16:03:00.000Z";

function seg(speaker: string | null, text: string, timestamp: number): TranscriptSegment {
  return { speaker, text, timestamp };
}

/** The speaker headings of a transcript, in order. */
function headings(body: string): string[] {
  return body.split("\n").filter((line) => line.startsWith("### "));
}

describe("buildTranscriptBody", () => {
  it("lays out the heading, then one block per speaker run", () => {
    const body = buildTranscriptBody(
      "Weekly sync",
      [seg("Samuel Johnson", "Hey, Jorge.", 34.004), seg("Jorge", "Good morning.", 37.695)],
      START,
      null,
      "You",
    );
    expect(body).toBe(
      [
        "# Transcript for: Weekly sync",
        "",
        "### Samuel Johnson (2026-10-20T16:03:34.004Z)",
        "",
        "Hey, Jorge.",
        "",
        "### Jorge (2026-10-20T16:03:37.695Z)",
        "",
        "Good morning.",
        "",
        "",
      ].join("\n"),
    );
  });

  it("merges consecutive segments by speaker", () => {
    const body = buildTranscriptBody(
      "T",
      [seg("A", "one", 1), seg("A", "two", 2), seg("B", "three", 3), seg("A", "four", 4)],
      START,
      null,
      "You",
    );
    expect(headings(body)).toEqual([
      "### A (2026-10-20T16:03:01.000Z)",
      "### B (2026-10-20T16:03:03.000Z)",
      "### A (2026-10-20T16:03:04.000Z)",
    ]);
    // The text of a run is joined with single spaces, and the run's time is its first segment's.
    expect(body).toContain("### A (2026-10-20T16:03:01.000Z)\n\none two\n\n");
  });

  it("labels the owner as You and null speakers Guest", () => {
    const body = buildTranscriptBody(
      "T",
      [seg("Owner Person", "hi", 1), seg(null, "who is this", 2), seg("Person A", "me", 3)],
      START,
      "Owner Person",
      "You",
    );
    expect(headings(body)).toEqual([
      "### You (2026-10-20T16:03:01.000Z)",
      "### Guest (2026-10-20T16:03:02.000Z)",
      "### Person A (2026-10-20T16:03:03.000Z)",
    ]);
  });

  it("uses the owner's name when selfLabel is name", () => {
    const body = buildTranscriptBody("T", [seg("Owner Person", "hi", 1)], START, "Owner Person", "Owner Person");
    expect(headings(body)).toEqual(["### Owner Person (2026-10-20T16:03:01.000Z)"]);
  });

  it("matches the owner's name without regard to case or surrounding spaces", () => {
    const body = buildTranscriptBody(
      "T",
      [seg("  owner PERSON ", "hi", 1), seg("Owner Person", "again", 2)],
      START,
      " Owner Person  ",
      "You",
    );
    // Both spellings are the owner, so they are one run.
    expect(headings(body)).toEqual(["### You (2026-10-20T16:03:01.000Z)"]);
  });

  it("does no self mapping when the owner's name is unknown", () => {
    const body = buildTranscriptBody("T", [seg("Owner Person", "hi", 1), seg(null, "hm", 2)], START, null, "You");
    expect(headings(body)).toEqual([
      "### Owner Person (2026-10-20T16:03:01.000Z)",
      "### Guest (2026-10-20T16:03:02.000Z)",
    ]);
  });

  it("does not let a blank owner name capture blank speakers", () => {
    const body = buildTranscriptBody("T", [seg("   ", "hm", 1)], START, "  ", "You");
    expect(headings(body)).toEqual(["### Guest (2026-10-20T16:03:01.000Z)"]);
  });

  it("merges runs on the final label, so null and blank speakers are one Guest", () => {
    const body = buildTranscriptBody("T", [seg(null, "a", 1), seg("  ", "b", 2), seg("Guest", "c", 3)], START, null, "You");
    expect(headings(body)).toEqual(["### Guest (2026-10-20T16:03:01.000Z)"]);
    expect(body).toContain("\n\na b c\n\n");
  });

  it("computes absolute UTC timestamps", () => {
    const body = buildTranscriptBody("T", [seg("A", "x", 34.004)], START, null, "You");
    expect(body).toContain("### A (2026-10-20T16:03:34.004Z)");
  });

  it("reads a start time with an offset as the same instant in UTC", () => {
    const body = buildTranscriptBody("T", [seg("A", "x", 0)], "2026-10-20T11:03:00-05:00", null, "You");
    expect(body).toContain("### A (2026-10-20T16:03:00.000Z)");
  });

  it("skips segments with no text", () => {
    const body = buildTranscriptBody("T", [seg("A", "one", 1), seg("B", "   ", 2), seg("A", " two ", 3)], START, null, "You");
    expect(headings(body)).toEqual(["### A (2026-10-20T16:03:01.000Z)"]);
    expect(body).toContain("\n\none two\n\n");
  });

  it("gives an empty transcript only the heading", () => {
    expect(buildTranscriptBody("Empty", [], START, null, "You")).toBe("# Transcript for: Empty\n\n");
  });

  it("keeps the title on one line", () => {
    const body = buildTranscriptBody("Line one\nLine two", [], START, null, "You");
    expect(body).toBe("# Transcript for: Line one Line two\n\n");
  });

  it("formats 10,000 segments in under a second", () => {
    // Runs of three segments per speaker, so every run boundary is a speaker change.
    const segments: TranscriptSegment[] = [];
    for (let i = 0; i < 10_000; i++) {
      segments.push(seg(`Speaker ${Math.floor(i / 3) % 2}`, `Segment number ${i}.`, i * 1.5));
    }
    const began = performance.now();
    const body = buildTranscriptBody("Long meeting", segments, START, "Speaker 0", "You");
    const elapsed = performance.now() - began;

    expect(elapsed).toBeLessThan(1000);
    const lines = headings(body);
    expect(lines).toHaveLength(Math.ceil(10_000 / 3));
    expect(lines[0]).toMatch(/^### You \(/);
    expect(lines[1]).toMatch(/^### Speaker 1 \(/);
  });
});
