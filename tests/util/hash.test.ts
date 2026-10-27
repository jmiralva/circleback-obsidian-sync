import { hashBody } from "../../src/util/hash";

describe("hashBody", () => {
  it("matches the published FNV-1a 32-bit test vectors", () => {
    expect(hashBody("")).toBe("811c9dc5");
    expect(hashBody("a")).toBe("e40c292c");
    expect(hashBody("foobar")).toBe("bf9cf968");
  });

  it("is 8 lowercase hex characters, with leading zeros kept", () => {
    for (const text of ["", "x", "Lorem ipsum", "line\nbreak", "tab\t"]) {
      expect(hashBody(text)).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("hashes the UTF-8 bytes, so every device gets the same answer for non-ASCII text", () => {
    // "é" is the two bytes c3 a9, and the emoji is four bytes. Hashing UTF-16 code units
    // instead would give different values, and so would a platform with another encoding.
    expect(hashBody("é")).toBe("1e9de8c1");
    expect(hashBody("\u{1F600}")).toBe("33a29608");
  });

  it("is deterministic and tells different bodies apart", () => {
    expect(hashBody("same")).toBe(hashBody("same"));
    expect(hashBody("same")).not.toBe(hashBody("Same"));
    expect(hashBody("a\n")).not.toBe(hashBody("a"));
  });
});
