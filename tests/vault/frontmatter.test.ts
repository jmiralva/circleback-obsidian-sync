import { parseFrontmatter, readFrontmatter, splitFrontmatter } from "../../src/vault/frontmatter";
import { createFakeApp } from "../harness/fakeApp";

describe("splitFrontmatter", () => {
  it("splits a note into its frontmatter block and its body", () => {
    expect(splitFrontmatter("---\na: 1\nb: 2\n---\nBody text\n")).toEqual({
      yaml: "a: 1\nb: 2\n",
      body: "Body text\n",
    });
  });

  it("keeps the body byte for byte, including leading blank lines and horizontal rules", () => {
    const body = "\n\n  indented\n---\nafter a rule\n\n";
    expect(splitFrontmatter(`---\na: 1\n---\n${body}`).body).toBe(body);
  });

  it("returns the whole text as the body when there is no frontmatter", () => {
    expect(splitFrontmatter("Just text\n---\nnot frontmatter\n")).toEqual({
      yaml: null,
      body: "Just text\n---\nnot frontmatter\n",
    });
    expect(splitFrontmatter("")).toEqual({ yaml: null, body: "" });
  });

  it("does not treat an unclosed fence as frontmatter", () => {
    const text = "---\na: 1\nBody with no closing fence\n";
    expect(splitFrontmatter(text)).toEqual({ yaml: null, body: text });
  });

  it("reads an empty block and a closing fence at the end of the file", () => {
    expect(splitFrontmatter("---\n---\nBody")).toEqual({ yaml: "", body: "Body" });
    expect(splitFrontmatter("---\na: 1\n---")).toEqual({ yaml: "a: 1\n", body: "" });
  });

  it("handles Windows line endings and trailing spaces on the fences", () => {
    expect(splitFrontmatter("---\r\na: 1\r\n---  \r\nBody\r\n")).toEqual({
      yaml: "a: 1\r\n",
      body: "Body\r\n",
    });
  });

  it("splits at the first closing fence only", () => {
    expect(splitFrontmatter("---\na: 1\n---\nx\n---\ny: 2\n---\nz")).toEqual({
      yaml: "a: 1\n",
      body: "x\n---\ny: 2\n---\nz",
    });
  });

  it("agrees with the fake app's processFrontMatter about where the body starts", async () => {
    const app = createFakeApp();
    const body = "\n# Heading\n\nText with --- inside\n---\n";
    const file = await app.vault.create("n.md", body);
    await app.fileManager.processFrontMatter(file, (fm) => {
      fm.circleback_id = "m1";
      fm.title = "A: tricky # title";
    });
    expect(splitFrontmatter(app.fileText("n.md")).body).toBe(body);
    await app.fileManager.processFrontMatter(file, (fm) => {
      fm.title = "Another";
    });
    expect(splitFrontmatter(app.fileText("n.md")).body).toBe(body);
  });
});

describe("parseFrontmatter", () => {
  it("parses a mapping", () => {
    expect(parseFrontmatter("a: 1\nb:\n  - x\n  - y\n")).toEqual({ a: 1, b: ["x", "y"] });
  });

  it("returns null when there is no block, an empty block, broken YAML, or something other than a mapping", () => {
    expect(parseFrontmatter(null)).toBeNull();
    expect(parseFrontmatter("")).toBeNull();
    expect(parseFrontmatter("key: [unclosed\n")).toBeNull();
    expect(parseFrontmatter("- just\n- a list\n")).toBeNull();
    expect(parseFrontmatter("just a string\n")).toBeNull();
  });
});

describe("readFrontmatter", () => {
  it("reads a file and parses its frontmatter, whether or not the metadata cache has indexed it", async () => {
    const app = createFakeApp({
      files: { "a.md": "---\ncircleback_id: x\n---\nbody", "plain.md": "no frontmatter" },
      unindexed: ["a.md"],
    });
    const a = app.vault.getFileByPath("a.md");
    const plain = app.vault.getFileByPath("plain.md");
    if (!a || !plain) throw new Error("fixture files missing");
    expect(await readFrontmatter(app, a)).toEqual({ circleback_id: "x" });
    expect(await readFrontmatter(app, plain)).toBeNull();
  });
});
