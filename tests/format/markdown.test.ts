import {
  findSection,
  insertLines,
  joinLines,
  lineEnding,
  normalizeHeading,
  parseHeading,
  scanFences,
  splitLines,
} from "../../src/format/markdown";

describe("splitLines and joinLines", () => {
  it("give back exactly the text they were given", () => {
    for (const text of ["", "a", "a\n", "a\n\nb", "a\r\nb\r\n", "a\r\nb\nc\r", "\n", "\r\n\r\n", "x\n  \n"]) {
      expect(joinLines(splitLines(text))).toBe(text);
    }
  });

  it("keeps each line's own ending apart from its text", () => {
    expect(splitLines("a\r\nb\nc")).toEqual([
      { text: "a", eol: "\r\n" },
      { text: "b", eol: "\n" },
      { text: "c", eol: "" },
    ]);
  });

  it("finds the ending a note mostly uses", () => {
    expect(lineEnding("a\r\nb")).toBe("\r\n");
    expect(lineEnding("a\nb")).toBe("\n");
    expect(lineEnding("")).toBe("\n");
  });
});

describe("insertLines", () => {
  it("adds a line ending to a last line that had none, and keeps the file without a final newline", () => {
    const lines = splitLines("a\nb");
    insertLines(lines, 2, ["c"], "\n");
    expect(joinLines(lines)).toBe("a\nb\nc");
  });

  it("uses the given ending for lines in the middle", () => {
    const lines = splitLines("a\r\nb\r\n");
    insertLines(lines, 1, ["x", "y"], "\r\n");
    expect(joinLines(lines)).toBe("a\r\nx\r\ny\r\nb\r\n");
  });
});

describe("parseHeading", () => {
  it("reads ATX headings", () => {
    expect(parseHeading("## Meetings")).toEqual({ level: 2, text: "Meetings" });
    expect(parseHeading("   ###   Spaced   ")).toEqual({ level: 3, text: "Spaced" });
    expect(parseHeading("# Closed ##")).toEqual({ level: 1, text: "Closed" });
    expect(parseHeading("###### Six")).toEqual({ level: 6, text: "Six" });
    expect(parseHeading("##")).toEqual({ level: 2, text: "" });
  });

  it("does not take other lines for headings", () => {
    for (const line of ["#hashtag", "####### seven", "    # code", "text # not", "- # item", ""]) {
      expect(parseHeading(line)).toBeNull();
    }
  });

  it("keeps a # that is part of the title", () => {
    expect(parseHeading("# C# notes")).toEqual({ level: 1, text: "C# notes" });
  });
});

describe("normalizeHeading", () => {
  it("accepts the heading the way the setting spells it", () => {
    expect(normalizeHeading("## Meetings")).toEqual({ level: 2, text: "Meetings", line: "## Meetings" });
  });

  it("is forgiving about a setting typed without the space, or without any #", () => {
    expect(normalizeHeading("#Meetings")).toEqual({ level: 1, text: "Meetings", line: "# Meetings" });
    expect(normalizeHeading("Meetings")).toEqual({ level: 1, text: "Meetings", line: "# Meetings" });
  });

  it("gives nothing for a heading with no text", () => {
    expect(normalizeHeading("")).toBeNull();
    expect(normalizeHeading("   ")).toBeNull();
    expect(normalizeHeading("##")).toBeNull();
  });
});

describe("scanFences", () => {
  it("marks fenced lines, fences included", () => {
    const { fenced, open } = scanFences(splitLines("a\n```\nb\n```\nc"));
    expect(fenced).toEqual([false, true, true, true, false]);
    expect(open).toBeNull();
  });

  it("closes a fence only with the same character and at least as many", () => {
    const { fenced } = scanFences(splitLines("````\n```\n~~~\n````\nafter"));
    expect(fenced).toEqual([true, true, true, true, false]);
  });

  it("does not open a backtick fence whose info string has a backtick", () => {
    expect(scanFences(splitLines("```inline``` code\ntext")).fenced).toEqual([false, false]);
  });

  it("reports a fence left open", () => {
    expect(scanFences(splitLines("~~~~\ntext")).open).toEqual({ char: "~", length: 4 });
  });
});

describe("findSection", () => {
  const spec = normalizeHeading("## Meetings");
  if (spec === null) throw new Error("test heading did not parse");

  it("gives the heading, the end, and the end of the content", () => {
    const lines = splitLines("# Top\n## Meetings\n- a\n- b\n\n\n## Next\n");
    const section = findSection(lines, spec);
    expect(section).toMatchObject({ headingIndex: 1, end: 6, contentEnd: 4 });
  });

  it("runs to the end of the note when nothing follows", () => {
    const section = findSection(splitLines("## Meetings\n- a\n\n"), spec);
    expect(section).toMatchObject({ headingIndex: 0, end: 3, contentEnd: 2 });
  });

  it("gives an empty section its heading as the end of its content", () => {
    const section = findSection(splitLines("## Meetings\n\n## Next\n"), spec);
    expect(section).toMatchObject({ headingIndex: 0, end: 2, contentEnd: 1 });
  });

  it("does not find a heading in frontmatter, where # starts a YAML comment", () => {
    const lines = splitLines("---\n## Meetings\ntitle: x\n---\nText\n");
    expect(findSection(lines, spec)).toBeNull();
    expect(findSection(splitLines("---\n## Meetings\n---\n## Meetings\n- a\n"), spec)).toMatchObject({ headingIndex: 3 });
  });

  it("does not take a --- at the top with no closing one for frontmatter", () => {
    expect(findSection(splitLines("---\n## Meetings\n- a\n"), spec)).toMatchObject({ headingIndex: 1 });
  });

  it("marks the lines of fenced code and frontmatter as verbatim", () => {
    const section = findSection(splitLines("---\na: 1\n---\n## Meetings\n```\ncode\n```\ntext\n"), spec);
    expect(section?.verbatim).toEqual([true, true, true, false, true, true, true, false]);
  });

  it("is null when there is no such heading", () => {
    expect(findSection(splitLines("# Meetings\n### Meetings\n"), spec)).toBeNull();
  });
});
