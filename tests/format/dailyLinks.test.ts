import { upsertLinkLines, type DailyLink } from "../../src/format/dailyLinks";

// Which meeting each link target belongs to. A target that is not here resolves to nothing,
// like a link to a file with no `circleback_id`.
const IDS: Record<string, string> = {
  "Circleback/a": "a",
  "Circleback/b": "b",
  "Circleback/c": "c",
  M: "m1",
};
const resolveId = (linkpath: string): string | null => IDS[linkpath] ?? null;

const HEADING = "## Meetings";

function link(id: string, time: string, alias = id.toUpperCase()): DailyLink {
  return { id, time, linkpath: `Circleback/${id}`, alias };
}

function own(id: string, time: string, alias = id.toUpperCase()): string {
  return `- ${time} - [[Circleback/${id}|${alias}]]`;
}

function note(...sectionLines: string[]): string {
  return ["# Daily", "", HEADING, ...sectionLines, "", "## Tasks", "- [ ] write", ""].join("\n");
}

function add(text: string, ...links: DailyLink[]): string {
  return upsertLinkLines(text, HEADING, links, [], resolveId);
}

describe("upsertLinkLines", () => {
  it("keeps hand-typed and Granola lines", () => {
    const text = note("- 09:00 - [[Meetings/Granola/x|x]]", "- note to self", own("a", "10:00"));
    const result = add(text, link("b", "11:00"));
    expect(result).toBe(note("- 09:00 - [[Meetings/Granola/x|x]]", "- note to self", own("a", "10:00"), own("b", "11:00")));
  });

  it("appends after the last line of a section that has no lines of its own, before the blank line and next heading", () => {
    const text = note("- 09:00 - [[Meetings/Granola/x|x]]", "- note to self");
    expect(add(text, link("a", "10:00"))).toBe(
      note("- 09:00 - [[Meetings/Granola/x|x]]", "- note to self", own("a", "10:00")),
    );
  });

  it("puts a line directly under the heading of an empty section and keeps the blank line after it", () => {
    expect(add(note(), link("a", "10:00"))).toBe(note(own("a", "10:00")));
  });

  it("inserts by time among own lines", () => {
    const text = note(own("a", "09:00"), own("c", "11:00"));
    expect(add(text, link("b", "10:00"))).toBe(note(own("a", "09:00"), own("b", "10:00"), own("c", "11:00")));
    expect(add(text, link("b", "08:00"))).toBe(note(own("b", "08:00"), own("a", "09:00"), own("c", "11:00")));
    expect(add(text, link("b", "12:00"))).toBe(note(own("a", "09:00"), own("c", "11:00"), own("b", "12:00")));
  });

  it("puts a line with the same time after the ones already there", () => {
    const text = note(own("a", "10:00"), own("c", "11:00"));
    expect(add(text, link("b", "10:00"))).toBe(note(own("a", "10:00"), own("b", "10:00"), own("c", "11:00")));
  });

  it("inserts before the first later own line even when hand-typed lines sit in between", () => {
    const text = note(own("a", "09:00"), "- thought about a", own("c", "11:00"));
    expect(add(text, link("b", "10:00"))).toBe(note(own("a", "09:00"), "- thought about a", own("b", "10:00"), own("c", "11:00")));
  });

  it("adds several links in time order", () => {
    const text = note(own("a", "09:00"));
    expect(add(text, link("c", "11:00"), link("b", "10:00"))).toBe(
      note(own("a", "09:00"), own("b", "10:00"), own("c", "11:00")),
    );
  });

  it("does not add a line when an edited line already links the meeting", () => {
    const text = note("- 10:00 - [[M|M]] (moved)");
    expect(upsertLinkLines(text, HEADING, [{ id: "m1", time: "10:00", linkpath: "M", alias: "M" }], [], resolveId)).toBe(text);
  });

  it("does not add a line when the meeting is linked in any other form", () => {
    for (const existing of ["- [[Circleback/a]] standup", "see ![[Circleback/a#Notes]]", "- 10:00 - [[Circleback/a|A]] "]) {
      const text = note(existing);
      expect(add(text, link("a", "10:00"))).toBe(text);
    }
  });

  it("adds nothing when an own line for the meeting is already there", () => {
    const text = note(own("a", "09:00"), own("b", "10:00"));
    expect(add(text, link("b", "10:00"))).toBe(text);
  });

  it("does not count a link outside the section as present", () => {
    const text = ["# Daily", "", "Talked to [[Circleback/a|A]] about it.", "", HEADING, "", "## Tasks", ""].join("\n");
    expect(add(text, link("a", "10:00"))).toBe(
      ["# Daily", "", "Talked to [[Circleback/a|A]] about it.", "", HEADING, own("a", "10:00"), "", "## Tasks", ""].join("\n"),
    );
  });

  it("does not count a link inside a code block as present", () => {
    const text = note("```", own("a", "10:00"), "```");
    expect(add(text, link("a", "10:00"))).toBe(note("```", own("a", "10:00"), "```", own("a", "10:00")));
  });

  it("removes an own line only for removeIds", () => {
    const text = note(
      "- 09:00 - [[Meetings/Granola/x|x]]",
      own("a", "09:30"),
      own("b", "10:00"),
      "- 10:00 - [[Circleback/a|A]] (moved)",
      "- 10:30 - [[Circleback/ghost|ghost]]",
    );
    const result = upsertLinkLines(text, HEADING, [], ["a"], resolveId);
    expect(result).toBe(
      note(
        "- 09:00 - [[Meetings/Granola/x|x]]",
        own("b", "10:00"),
        "- 10:00 - [[Circleback/a|A]] (moved)",
        "- 10:30 - [[Circleback/ghost|ghost]]",
      ),
    );
  });

  it("removes nothing when the id is not in removeIds", () => {
    const text = note(own("a", "09:30"), own("b", "10:00"));
    expect(upsertLinkLines(text, HEADING, [], ["c"], resolveId)).toBe(text);
  });

  it("leaves an own line outside the section alone", () => {
    const text = ["# Daily", own("a", "09:00"), "", HEADING, own("b", "10:00"), ""].join("\n");
    expect(upsertLinkLines(text, HEADING, [], ["a", "b"], resolveId)).toBe(["# Daily", own("a", "09:00"), "", HEADING, ""].join("\n"));
  });

  it("does nothing to a note without the section when only removing", () => {
    const text = "# Daily\n\nJust text.\n";
    expect(upsertLinkLines(text, HEADING, [], ["a"], resolveId)).toBe(text);
  });

  it("creates the heading when missing", () => {
    expect(add("# Daily\n", link("a", "10:00"))).toBe(`# Daily\n\n${HEADING}\n${own("a", "10:00")}\n`);
  });

  it("creates the heading after a note that does not end in a newline, without joining its last line", () => {
    expect(add("# Daily\nText", link("a", "10:00"))).toBe(`# Daily\nText\n\n${HEADING}\n${own("a", "10:00")}\n`);
  });

  it("creates the heading in an empty note", () => {
    expect(add("", link("a", "10:00"))).toBe(`${HEADING}\n${own("a", "10:00")}\n`);
  });

  it("puts all new links in the heading it creates, in time order", () => {
    expect(add("# Daily\n", link("b", "11:00"), link("a", "10:00"))).toBe(
      `# Daily\n\n${HEADING}\n${own("a", "10:00")}\n${own("b", "11:00")}\n`,
    );
  });

  it("replaces ] and | in aliases", () => {
    expect(add(note(), link("a", "10:00", "A] | B\nC"))).toBe(note("- 10:00 - [[Circleback/a|A_ _ B C]]"));
  });

  it("writes an alias that is read back as its own line", () => {
    const first = add(note(), link("a", "10:00", "Q3 [draft] | review"));
    expect(add(first, link("a", "10:00", "Q3 [draft] | review"))).toBe(first);
    expect(upsertLinkLines(first, HEADING, [], ["a"], resolveId)).toBe(note());
  });

  describe("where the section is", () => {
    it("ends at the next heading of the same level", () => {
      const text = ["## Meetings", own("a", "09:00"), "## Other", "- x", ""].join("\n");
      expect(add(text, link("b", "10:00"))).toBe(["## Meetings", own("a", "09:00"), own("b", "10:00"), "## Other", "- x", ""].join("\n"));
    });

    it("ends at the next heading of a higher level", () => {
      const text = ["## Meetings", own("a", "09:00"), "# Big", ""].join("\n");
      expect(add(text, link("b", "10:00"))).toBe(["## Meetings", own("a", "09:00"), own("b", "10:00"), "# Big", ""].join("\n"));
    });

    it("includes deeper headings", () => {
      const text = ["## Meetings", "### Standup", "- notes", "", "## Tasks", ""].join("\n");
      expect(add(text, link("a", "10:00"))).toBe(["## Meetings", "### Standup", "- notes", own("a", "10:00"), "", "## Tasks", ""].join("\n"));
    });

    it("ignores headings inside fenced code blocks", () => {
      const text = ["```md", "## Meetings", "```", HEADING, own("a", "09:00"), "```", "## Tasks", "```", "", "## Real", ""].join("\n");
      expect(add(text, link("b", "10:00"))).toBe(
        ["```md", "## Meetings", "```", HEADING, own("a", "09:00"), "```", "## Tasks", "```", own("b", "10:00"), "", "## Real", ""].join("\n"),
      );
    });

    it("finds the heading whatever its case or spacing", () => {
      const text = "##   meetings  ##\n- 09:00 - [[Meetings/Granola/x|x]]\n";
      expect(add(text, link("a", "10:00"))).toBe(`##   meetings  ##\n- 09:00 - [[Meetings/Granola/x|x]]\n${own("a", "10:00")}\n`);
    });

    it("does not take a heading of another level for the section", () => {
      const text = "# Meetings\n- x\n";
      expect(add(text, link("a", "10:00"))).toBe(`# Meetings\n- x\n\n${HEADING}\n${own("a", "10:00")}\n`);
    });

    it("uses the first matching heading", () => {
      const text = `${HEADING}\n${HEADING}\n- later\n`;
      expect(add(text, link("a", "10:00"))).toBe(`${HEADING}\n${own("a", "10:00")}\n${HEADING}\n- later\n`);
    });

    it("does not look for the heading in frontmatter, where # starts a YAML comment", () => {
      const text = "---\n# Meetings\ntags: daily\n---\n# Daily\n";
      expect(upsertLinkLines(text, "# Meetings", [link("a", "10:00")], [], resolveId)).toBe(
        `---\n# Meetings\ntags: daily\n---\n# Daily\n\n# Meetings\n${own("a", "10:00")}\n`,
      );
    });

    it("treats a heading setting without # as a level 1 heading", () => {
      expect(upsertLinkLines("# Daily\n", "Meetings", [link("a", "10:00")], [], resolveId)).toBe(
        `# Daily\n\n# Meetings\n${own("a", "10:00")}\n`,
      );
    });

    it("changes nothing when the heading setting is empty", () => {
      expect(upsertLinkLines("# Daily\n", "  ", [link("a", "10:00")], [], resolveId)).toBe("# Daily\n");
    });
  });

  describe("line endings and the end of the file", () => {
    it("keeps CRLF notes CRLF, and every line it did not write byte for byte", () => {
      const text = ["# Daily", "", HEADING, own("a", "09:00"), "- hand typed", "", "## Tasks", ""].join("\r\n");
      expect(add(text, link("b", "10:00"))).toBe(
        ["# Daily", "", HEADING, own("a", "09:00"), "- hand typed", own("b", "10:00"), "", "## Tasks", ""].join("\r\n"),
      );
    });

    it("finds and removes own lines in a CRLF note", () => {
      const text = ["# Daily", HEADING, own("a", "09:00"), own("b", "10:00"), ""].join("\r\n");
      expect(upsertLinkLines(text, HEADING, [], ["a"], resolveId)).toBe(["# Daily", HEADING, own("b", "10:00"), ""].join("\r\n"));
    });

    it("does not add a trailing newline to a note that has none", () => {
      const text = `${HEADING}\n${own("a", "09:00")}`;
      expect(add(text, link("b", "10:00"))).toBe(`${HEADING}\n${own("a", "09:00")}\n${own("b", "10:00")}`);
    });

    it("keeps a note exactly as it is when there is nothing to do", () => {
      const text = "# Daily\r\n\nmixed endings\r\n\r\n## Meetings\n- x\r\n  \n";
      expect(upsertLinkLines(text, HEADING, [], [], resolveId)).toBe(text);
      expect(upsertLinkLines(text, HEADING, [], ["a"], resolveId)).toBe(text);
    });
  });
});
