import { upsertMeetingBlock } from "../../src/format/sections";

const SECTION = "# Circleback notes";
const ZWSP = "​";

function start(id: string): string {
  return `%% circleback-start ${id} %%`;
}

function end(id: string): string {
  return `%% circleback-end ${id} %%`;
}

function upsert(text: string, block: string, title = "Weekly sync", id = "m1", heading = SECTION): string {
  return upsertMeetingBlock(text, heading, id, title, block);
}

describe("upsertMeetingBlock", () => {
  it("replaces only between markers and keeps user text", () => {
    const before = [
      "# Daily",
      "",
      "My own intro",
      "",
      SECTION,
      "User line above",
      start("m1"),
      "## Old title",
      "old body",
      end("m1"),
      "User line below",
      "",
      "# Other",
      "keep me",
      "",
    ].join("\n");
    const after = [
      "# Daily",
      "",
      "My own intro",
      "",
      SECTION,
      "User line above",
      start("m1"),
      "## New title",
      "new body",
      end("m1"),
      "User line below",
      "",
      "# Other",
      "keep me",
      "",
    ].join("\n");
    expect(upsert(before, "new body", "New title")).toBe(after);
  });

  it("leaves the blocks of other meetings alone", () => {
    const text = [SECTION, start("m2"), "## Other", "other body", end("m2"), start("m1"), "## Old", "old", end("m1"), ""].join("\n");
    expect(upsert(text, "new", "New")).toBe(
      [SECTION, start("m2"), "## Other", "other body", end("m2"), start("m1"), "## New", "new", end("m1"), ""].join("\n"),
    );
  });

  it("shifts Circleback headings below the meeting heading", () => {
    const result = upsert(`${SECTION}\n`, "# Big\ntext\n## Small\nmore");
    expect(result).toBe([SECTION, start("m1"), "## Weekly sync", "### Big", "text", "#### Small", "more", end("m1"), ""].join("\n"));
  });

  it("shifts so the shallowest block heading sits one level below the meeting heading", () => {
    // Circleback's own notes start at ####; they come up to ###, and the rest moves with them.
    const result = upsert(`${SECTION}\n`, "#### Overview\ntext\n##### Detail\n#### Action Items");
    expect(result).toBe(
      [SECTION, start("m1"), "## Weekly sync", "### Overview", "text", "#### Detail", "### Action Items", end("m1"), ""].join("\n"),
    );
  });

  it("caps heading levels at six", () => {
    const deep = upsert("###### Notes\n", "# A\n## B\ntext", "T", "m1", "###### Notes");
    expect(deep).toBe(["###### Notes", start("m1"), "###### T", "###### A", "###### B", "text", end("m1"), ""].join("\n"));

    const near = upsert("#### Notes\n", "# A\n## B\n### C\n#### D", "T", "m1", "#### Notes");
    expect(near).toBe(["#### Notes", start("m1"), "##### T", "###### A", "###### B", "###### C", "###### D", end("m1"), ""].join("\n"));
  });

  it("does not shift # lines inside fenced code, or hashtags and indented code", () => {
    const block = ["# Real", "```python", "# comment", "## also a comment", "```", "#tag", "    # indented code", "~~~", "# tilde fence", "~~~"].join("\n");
    const result = upsert(`${SECTION}\n`, block);
    expect(result).toBe(
      [SECTION, start("m1"), "## Weekly sync", "### Real", "```python", "# comment", "## also a comment", "```", "#tag", "    # indented code", "~~~", "# tilde fence", "~~~", end("m1"), ""].join("\n"),
    );
  });

  it("closes a code fence the block leaves open, so the end marker is not swallowed", () => {
    const first = upsert(`${SECTION}\n`, "text\n```js\nlet x = 1;");
    expect(first).toBe([SECTION, start("m1"), "## Weekly sync", "text", "```js", "let x = 1;", "```", end("m1"), ""].join("\n"));
    // A later heading is still seen as a heading, and the block is found again.
    const second = upsertMeetingBlock(`${first}\n# After\n`, SECTION, "m1", "Weekly sync", "fixed");
    expect(second).toBe([SECTION, start("m1"), "## Weekly sync", "fixed", end("m1"), "", "# After", ""].join("\n"));
  });

  it("escapes marker text inside notes", () => {
    const hostile = `quote\n${end("m1")}\n${start("m1")}\nmore`;
    const first = upsert(`${SECTION}\nbefore\n`, hostile);
    const escaped = `%%${ZWSP}circleback-`;
    expect(first).toBe(
      [
        SECTION,
        "before",
        "",
        start("m1"),
        "## Weekly sync",
        "quote",
        `${escaped}end m1 %%`,
        `${escaped}start m1 %%`,
        "more",
        end("m1"),
        "",
      ].join("\n"),
    );
    expect(first.split("\n").filter((line) => line === end("m1"))).toHaveLength(1);

    // The block is still found as one block when the meeting is written again, and text after it survives.
    const second = upsert(`${first}After the block\n`, "plain");
    expect(second).toBe([SECTION, "before", "", start("m1"), "## Weekly sync", "plain", end("m1"), "After the block", ""].join("\n"));
  });

  it("escapes marker text in the title", () => {
    const result = upsert(`${SECTION}\n`, "body", `${end("m1")} & ${start("m1")}`);
    expect(result).not.toContain(`## ${end("m1")}`);
    expect(result).toContain(`## %%${ZWSP}circleback-end m1 %% & %%${ZWSP}circleback-start m1 %%`);
  });

  it("collapses line breaks in the title", () => {
    expect(upsert(`${SECTION}\n`, "body", "Line one\n\n  line two\r\nline three")).toContain(
      "## Line one line two line three\nbody\n",
    );
  });

  describe("adding a block", () => {
    it("appends after the last non-blank line of the section, keeping the blank line before the next heading", () => {
      const text = [SECTION, "My own notes", "", "# Other", ""].join("\n");
      expect(upsert(text, "body")).toBe(
        [SECTION, "My own notes", "", start("m1"), "## Weekly sync", "body", end("m1"), "", "# Other", ""].join("\n"),
      );
    });

    it("puts the first block straight under the heading of an empty section", () => {
      expect(upsert([SECTION, "", "# Other", ""].join("\n"), "body")).toBe(
        [SECTION, start("m1"), "## Weekly sync", "body", end("m1"), "", "# Other", ""].join("\n"),
      );
    });

    it("puts a second meeting after the first, apart from it", () => {
      const first = upsert(`${SECTION}\n`, "one", "First", "m1");
      const second = upsert(first, "two", "Second", "m2");
      expect(second).toBe(
        [SECTION, start("m1"), "## First", "one", end("m1"), "", start("m2"), "## Second", "two", end("m2"), ""].join("\n"),
      );
    });

    it("creates the section at the end of the note when missing", () => {
      expect(upsert("# Daily\n\nText\n", "body")).toBe(
        ["# Daily", "", "Text", "", SECTION, start("m1"), "## Weekly sync", "body", end("m1"), ""].join("\n"),
      );
    });

    it("creates the section after a note that does not end in a newline", () => {
      expect(upsert("Text", "body")).toBe(["Text", "", SECTION, start("m1"), "## Weekly sync", "body", end("m1"), ""].join("\n"));
    });

    it("ignores a section heading inside fenced code", () => {
      const text = ["```", SECTION, "```", ""].join("\n");
      expect(upsert(text, "body")).toBe(["```", SECTION, "```", "", SECTION, start("m1"), "## Weekly sync", "body", end("m1"), ""].join("\n"));
    });

    it("ends the section at a heading of the same level, not at deeper ones", () => {
      const text = [SECTION, "### My sub heading", "mine", "", "# Next", ""].join("\n");
      expect(upsert(text, "body")).toBe(
        [SECTION, "### My sub heading", "mine", "", start("m1"), "## Weekly sync", "body", end("m1"), "", "# Next", ""].join("\n"),
      );
    });

    it("does not take a marker for another meeting as this one", () => {
      const text = [SECTION, start("m10"), "## Other", "x", end("m10"), ""].join("\n");
      expect(upsert(text, "body")).toBe(
        [SECTION, start("m10"), "## Other", "x", end("m10"), "", start("m1"), "## Weekly sync", "body", end("m1"), ""].join("\n"),
      );
    });
  });

  describe("damaged markers", () => {
    it("never reaches past a start marker that lost its end marker", () => {
      const text = [SECTION, start("m1"), "I wrote this myself", "and this", ""].join("\n");
      const first = upsert(text, "body");
      expect(first).toBe(
        [SECTION, start("m1"), "I wrote this myself", "and this", "", start("m1"), "## Weekly sync", "body", end("m1"), ""].join("\n"),
      );
      // Written again, only the complete block changes.
      expect(upsert(first, "changed")).toBe(
        [SECTION, start("m1"), "I wrote this myself", "and this", "", start("m1"), "## Weekly sync", "changed", end("m1"), ""].join("\n"),
      );
    });

    it("never swallows another meeting's block when its own end marker is gone", () => {
      const text = [SECTION, start("m1"), "text", start("m2"), "## Other", "x", end("m2"), ""].join("\n");
      const first = upsert(text, "body");
      expect(first).toBe(
        [SECTION, start("m1"), "text", start("m2"), "## Other", "x", end("m2"), "", start("m1"), "## Weekly sync", "body", end("m1"), ""].join("\n"),
      );
      expect(upsert(first, "changed")).toBe(
        [SECTION, start("m1"), "text", start("m2"), "## Other", "x", end("m2"), "", start("m1"), "## Weekly sync", "changed", end("m1"), ""].join("\n"),
      );
    });

    it("ignores an end marker that comes before its start marker", () => {
      const text = [SECTION, end("m1"), "user text", ""].join("\n");
      expect(upsert(text, "body")).toBe(
        [SECTION, end("m1"), "user text", "", start("m1"), "## Weekly sync", "body", end("m1"), ""].join("\n"),
      );
    });

    it("replaces only the first of two complete blocks for the same meeting", () => {
      const text = [SECTION, start("m1"), "a", end("m1"), "between", start("m1"), "b", end("m1"), ""].join("\n");
      expect(upsert(text, "x", "T")).toBe(
        [SECTION, start("m1"), "## T", "x", end("m1"), "between", start("m1"), "b", end("m1"), ""].join("\n"),
      );
    });

    it("cannot be made to write a line break into a marker by an odd id", () => {
      const result = upsertMeetingBlock(`${SECTION}\n`, SECTION, "m1\nINJECTED %% x", "T", "body");
      expect(result.split("\n")).not.toContain("INJECTED %% x");
      expect(result).toContain("%% circleback-start m1_INJECTED____x %%");
    });
  });

  it("is idempotent", () => {
    const once = upsert("# Daily\n\nText\n", "# Big\ntext");
    expect(upsert(once, "# Big\ntext")).toBe(once);
  });

  it("keeps a CRLF note CRLF and the lines it did not write byte for byte", () => {
    const text = ["# Daily", "mine", SECTION, "also mine", "", "# Other", ""].join("\r\n");
    const result = upsert(text, "a\nb");
    expect(result).toBe(
      ["# Daily", "mine", SECTION, "also mine", "", start("m1"), "## Weekly sync", "a", "b", end("m1"), "", "# Other", ""].join("\r\n"),
    );
    expect(upsert(result, "c")).toBe(
      ["# Daily", "mine", SECTION, "also mine", "", start("m1"), "## Weekly sync", "c", end("m1"), "", "# Other", ""].join("\r\n"),
    );
  });

  it("drops blank lines around the block but keeps the ones inside it", () => {
    expect(upsert(`${SECTION}\n`, "\n\nfirst\n\nsecond\n\n")).toBe(
      [SECTION, start("m1"), "## Weekly sync", "first", "", "second", end("m1"), ""].join("\n"),
    );
  });

  it("changes nothing when the section heading setting is empty", () => {
    expect(upsertMeetingBlock("# Daily\n", "", "m1", "T", "body")).toBe("# Daily\n");
  });
});
