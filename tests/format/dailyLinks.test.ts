import { upsertLinkLines, type DailyLink, type LinkTarget } from "../../src/format/dailyLinks";

// The note each link target points to. A target that is not here resolves to nothing, like a
// link to a file with no `circleback_id`.
const NOTES: Record<string, LinkTarget> = {
  "Circleback/a": { id: "a", path: "Circleback/a.md" },
  "Circleback/b": { id: "b", path: "Circleback/b.md" },
  "Circleback/c": { id: "c", path: "Circleback/c.md" },
  M: { id: "m1", path: "M.md" },
  // Meeting a's note as it was before the user moved it out of the sync folder: a file of
  // meeting a, but not the one the plugin links to now.
  "Archive/a": { id: "a", path: "Archive/a.md" },
  "Other/a": { id: "a", path: "Other/a.md" },
  // Short links that Obsidian resolves to the notes in the sync folder.
  a: { id: "a", path: "Circleback/a.md" },
  b: { id: "b", path: "Circleback/b.md" },
};
const resolveId = (linkpath: string): LinkTarget | null => NOTES[linkpath] ?? null;

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

/** Removes the meetings' own lines, as the plugin wrote them (alias = the id in capitals, like `own`). */
function drop(text: string, ...ids: string[]): string {
  return upsertLinkLines(text, HEADING, [], ids.map((id) => ({ id, alias: id.toUpperCase() })), resolveId);
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

  describe("a meeting whose note moved out of the sync folder", () => {
    it("points the plugin's own line for the meeting at the file being linked, in place", () => {
      const text = note("- 09:00 - standup", "- 10:00 - [[Archive/a|A]]", own("b", "11:00"));
      expect(add(text, link("a", "10:00"))).toBe(note("- 09:00 - standup", own("a", "10:00"), own("b", "11:00")));
    });

    it("writes the line as the plugin writes it now, with the current time, and keeps its place", () => {
      const text = note("- 10:00 - [[Archive/a|A]]", own("b", "10:30"));
      expect(add(text, link("a", "11:00"))).toBe(note(own("a", "11:00"), own("b", "10:30")));
    });

    it("leaves an own line whose alias is not the one the plugin writes now, and adds no second line", () => {
      // The user changed the link's text, or the meeting was renamed since: either way it is not the plugin's to rewrite.
      const text = note("- 10:00 - [[Archive/a|my notes on the call]]");
      expect(add(text, link("a", "10:00"))).toBe(text);
      expect(add(note("- 10:00 - [[Archive/a|Old title]]"), link("a", "10:00", "New title"))).toBe(
        note("- 10:00 - [[Archive/a|Old title]]"),
      );
    });

    it("compares the alias after the cleaning new lines get", () => {
      const text = note("- 10:00 - [[Archive/a|Q3 [draft_ _ review]]");
      expect(add(text, link("a", "10:00", "Q3 [draft] | review"))).toBe(note("- 10:00 - [[Circleback/a|Q3 [draft_ _ review]]"));
    });

    it("keeps the line ending and a missing newline at the end of the note", () => {
      expect(add(`${HEADING}
- 10:00 - [[Archive/a|A]]
`, link("a", "10:00"))).toBe(`${HEADING}
${own("a", "10:00")}
`);
      expect(add(`${HEADING}
- 10:00 - [[Archive/a|A]]`, link("a", "10:00"))).toBe(`${HEADING}
${own("a", "10:00")}`);
    });

    it("leaves a line the user edited that links to another file of the meeting, and adds no second line", () => {
      for (const edited of ["- 10:00 - [[Archive/a|A]] (filed under the project)", "- see [[Archive/a]]"]) {
        const text = note(edited);
        expect(add(text, link("a", "10:00"))).toBe(text);
      }
    });

    it("changes nothing when another line already links to the file being linked", () => {
      const text = note("- [[Circleback/a]] my notes", "- 10:00 - [[Archive/a|A]]");
      expect(add(text, link("a", "10:00"))).toBe(text);
    });

    it("still repoints its own line when a line the user edited also links to the moved copy", () => {
      const text = note("- [[Archive/a]] my notes", "- 10:00 - [[Archive/a|A]]");
      expect(add(text, link("a", "10:00"))).toBe(note("- [[Archive/a]] my notes", own("a", "10:00")));
    });

    it("repoints only the first of several own lines for the meeting", () => {
      const text = note("- 10:00 - [[Archive/a|A]]", "- 10:00 - [[Other/a|A]]");
      expect(add(text, link("a", "10:00"))).toBe(note(own("a", "10:00"), "- 10:00 - [[Other/a|A]]"));
    });

    it("does not touch another meeting's own line", () => {
      const text = note(own("b", "10:00"));
      expect(add(text, link("a", "10:00"))).toBe(note(own("b", "10:00"), own("a", "10:00")));
    });
  });

  describe("keeping the plugin's own line for a meeting current", () => {
    it("writes a short link to the note being linked as the full path, in place", () => {
      // Obsidian shortens a link to the file name when it can. The short form is the note's name only,
      // so it stops pointing at the right file as soon as another file has the same name.
      const text = note("- 09:00 - standup", "- 10:00 - [[a|A]]", own("b", "11:00"));
      expect(add(text, link("a", "10:00"))).toBe(note("- 09:00 - standup", own("a", "10:00"), own("b", "11:00")));
    });

    it("points a link to a moved copy at the note being linked", () => {
      const text = note("- 09:00 - standup", "- 10:00 - [[Archive/a|A]]", own("b", "11:00"));
      expect(add(text, link("a", "10:00"))).toBe(note("- 09:00 - standup", own("a", "10:00"), own("b", "11:00")));
    });

    it("gives the line the current time, where it is", () => {
      const text = note(own("a", "09:00"), own("b", "10:00"));
      expect(add(text, link("a", "09:30"))).toBe(note(own("a", "09:30"), own("b", "10:00")));
    });

    it("does not move the line to keep the time order when its time changes", () => {
      const text = note(own("a", "09:00"), own("b", "10:00"));
      expect(add(text, link("a", "11:00"))).toBe(note(own("a", "11:00"), own("b", "10:00")));
      const later = note(own("a", "11:00"), own("b", "10:00"));
      expect(add(later, link("a", "08:00"))).toBe(note(own("a", "08:00"), own("b", "10:00")));
    });

    it("fixes the time and the path of a line in one go", () => {
      expect(add(note("- 09:00 - [[a|A]]"), link("a", "10:00"))).toBe(note(own("a", "10:00")));
    });

    it("returns a note whose line is already current unchanged", () => {
      const text = note("- 09:00 - standup", own("a", "10:00"), own("b", "11:00"));
      expect(add(text, link("a", "10:00"))).toBe(text);
      expect(add(text, link("a", "10:00"), link("b", "11:00"))).toBe(text);
    });

    it("rewrites the line to the cleaned current title only while the line has that title", () => {
      const text = note("- 10:00 - [[a|Q3 [draft_ _ review]]");
      expect(add(text, link("a", "10:30", "Q3 [draft] | review"))).toBe(note("- 10:30 - [[Circleback/a|Q3 [draft_ _ review]]"));
    });

    it("leaves a line you edited alone, and adds no second line", () => {
      for (const edited of [
        "- 10:00 - [[a|A]] (moved to 10:30)",
        "- 10:00 - [[Circleback/a|A]] (moved to 10:30)",
        "- 09:00 - [[a|A]] ",
        "- 10:00 - [[Circleback/a|my notes on the call]]",
        "- 10:00 - [[a|my notes on the call]]",
        "- see [[a]]",
      ]) {
        const text = note(edited);
        expect(add(text, link("a", "10:30"))).toBe(text);
      }
    });

    it("leaves a line that still shows an older title, and adds no second line", () => {
      const text = note("- 10:00 - [[a|Old title]]", "- 10:00 - [[Archive/a|Old title]]");
      expect(add(text, link("a", "10:30", "New title"))).toBe(text);
    });

    it("leaves lines from other tools and hand-typed lines alone, whatever they say", () => {
      const text = note(
        "- 09:00 - [[Meetings/Granola/a|A]]",
        "- 10:00 - a standup, the A meeting",
        "- [[Meetings/Granola/x|x]] with A",
        own("b", "11:00"),
      );
      expect(add(text, link("a", "10:00"))).toBe(
        note(
          "- 09:00 - [[Meetings/Granola/a|A]]",
          "- 10:00 - a standup, the A meeting",
          "- [[Meetings/Granola/x|x]] with A",
          own("a", "10:00"),
          own("b", "11:00"),
        ),
      );
    });

    it("updates the first of several own lines and leaves the rest", () => {
      const text = note("- 09:00 - [[a|A]]", "- 09:30 - [[Archive/a|A]]", "- 10:15 - [[Other/a|A]]");
      expect(add(text, link("a", "10:00"))).toBe(note(own("a", "10:00"), "- 09:30 - [[Archive/a|A]]", "- 10:15 - [[Other/a|A]]"));
    });

    it("skips a line you edited to update the own line after it", () => {
      const text = note("- 10:00 - [[Archive/a|my notes]]", "- 10:00 - [[Archive/a|A]]");
      expect(add(text, link("a", "10:30"))).toBe(note("- 10:00 - [[Archive/a|my notes]]", own("a", "10:30")));
    });

    it("leaves a line alone when another line you wrote links to the note being linked", () => {
      const text = note("- 09:00 - [[a|A]]", "- [[Circleback/a]] my notes");
      expect(add(text, link("a", "10:00"))).toBe(text);
    });

    it("leaves the other meetings' own lines alone", () => {
      const text = note("- 09:00 - [[b|B]]", own("b", "10:00"), own("a", "11:00"));
      expect(add(text, link("a", "11:30"))).toBe(note("- 09:00 - [[b|B]]", own("b", "10:00"), own("a", "11:30")));
    });

    it("keeps the line ending and a missing newline at the end of the note", () => {
      expect(add(`${HEADING}\r\n- 09:00 - [[a|A]]\r\n- x\r\n`, link("a", "10:00"))).toBe(`${HEADING}\r\n${own("a", "10:00")}\r\n- x\r\n`);
      expect(add(`${HEADING}\n- 09:00 - [[a|A]]`, link("a", "10:00"))).toBe(`${HEADING}\n${own("a", "10:00")}`);
    });

    it("does not rewrite a line outside the section", () => {
      const text = ["# Daily", "- 09:00 - [[a|A]]", "", HEADING, "", "## Tasks", ""].join("\n");
      expect(add(text, link("a", "10:00"))).toBe(["# Daily", "- 09:00 - [[a|A]]", "", HEADING, own("a", "10:00"), "", "## Tasks", ""].join("\n"));
    });

    it("does not rewrite a line inside a code block", () => {
      const text = note("```", "- 09:00 - [[a|A]]", "```");
      expect(add(text, link("a", "10:00"))).toBe(note("```", "- 09:00 - [[a|A]]", "```", own("a", "10:00")));
    });
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
    const result = drop(text, "a");
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
    expect(drop(text, "c")).toBe(text);
  });

  it("keeps a line whose alias the user changed, even for a meeting being removed", () => {
    const renamed = "- 09:30 - [[Circleback/a|my own name for it]]";
    const text = note(renamed, own("b", "10:00"));
    expect(drop(text, "a", "b")).toBe(note(renamed));
    // It still holds its place in the time order, and still counts as the meeting being there.
    expect(add(text, link("c", "09:45"))).toBe(note(renamed, own("c", "09:45"), own("b", "10:00")));
    expect(add(text, link("a", "09:30"))).toBe(text);
  });

  it("removes a line only if its alias is exactly the one the plugin writes now", () => {
    const text = note(own("a", "09:00", "Old name"), own("b", "10:00", "B"));
    // "a" was renamed upstream in the same run: the stale line stays, which is the safe direction.
    expect(upsertLinkLines(text, HEADING, [], [{ id: "a", alias: "New name" }], resolveId)).toBe(text);
    expect(upsertLinkLines(text, HEADING, [], [{ id: "a", alias: "Old name" }], resolveId)).toBe(note(own("b", "10:00", "B")));
  });

  it("compares the alias after the cleaning new lines get", () => {
    const text = note(own("a", "09:00", "Q3 _draft_ _ review final"));
    expect(upsertLinkLines(text, HEADING, [], [{ id: "a", alias: "Q3 ]draft] | review\nfinal" }], resolveId)).toBe(note());
  });

  it("leaves an own line outside the section alone", () => {
    const text = ["# Daily", own("a", "09:00"), "", HEADING, own("b", "10:00"), ""].join("\n");
    expect(drop(text, "a", "b")).toBe(["# Daily", own("a", "09:00"), "", HEADING, ""].join("\n"));
  });

  it("does nothing to a note without the section when only removing", () => {
    const text = "# Daily\n\nJust text.\n";
    expect(drop(text, "a")).toBe(text);
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
    expect(upsertLinkLines(first, HEADING, [], [{ id: "a", alias: "Q3 [draft] | review" }], resolveId)).toBe(note());
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
      expect(drop(text, "a")).toBe(["# Daily", HEADING, own("b", "10:00"), ""].join("\r\n"));
    });

    it("does not add a trailing newline to a note that has none", () => {
      const text = `${HEADING}\n${own("a", "09:00")}`;
      expect(add(text, link("b", "10:00"))).toBe(`${HEADING}\n${own("a", "09:00")}\n${own("b", "10:00")}`);
    });

    it("keeps a note exactly as it is when there is nothing to do", () => {
      const text = "# Daily\r\n\nmixed endings\r\n\r\n## Meetings\n- x\r\n  \n";
      expect(upsertLinkLines(text, HEADING, [], [], resolveId)).toBe(text);
      expect(drop(text, "a")).toBe(text);
    });
  });
});
