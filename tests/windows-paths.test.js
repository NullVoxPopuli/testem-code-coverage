import { describe, it, expect } from "vitest";
import { toPosixPath } from "#utils";

describe("toPosixPath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(toPosixPath("C:\\foo\\bar\\baz.js")).toBe("C:/foo/bar/baz.js");
  });

  it("converts mixed slashes to forward slashes", () => {
    expect(toPosixPath("C:/foo\\bar/baz.js")).toBe("C:/foo/bar/baz.js");
  });

  it("handles non-string inputs safely", () => {
    expect(toPosixPath(null)).toBe("null");
    expect(toPosixPath(undefined)).toBe("undefined");
    expect(toPosixPath(123)).toBe("123");
  });
});
