import { describe, expect, it } from "vitest";
import { sanitize, SANITIZE_FIELD_CAP } from "../src/lib/sanitize.js";

describe("sanitize() - control char strip and caps (unit)", () => {
  it("returns empty string for null, undefined, and empty input", () => {
    expect(sanitize(null)).toBe("");
    expect(sanitize(undefined)).toBe("");
    expect(sanitize("")).toBe("");
  });

  it("replaces control chars 0x00-0x1F with spaces", () => {
    const dirty = "a" + String.fromCharCode(0) + "b" + String.fromCharCode(0x1f) + "c";
    expect(sanitize(dirty)).toBe("a b c");
  });

  it("replaces DEL (0x7F) with a space", () => {
    const dirty = "x" + String.fromCharCode(0x7f) + "y";
    expect(sanitize(dirty)).toBe("x y");
  });

  it("replaces newlines and tabs with spaces (word boundaries preserved)", () => {
    expect(sanitize("line1\nline2\tend")).toBe("line1 line2 end");
  });

  it("passes printable ASCII and unicode through unchanged", () => {
    const clean = "FAR 52.219-14, naive resume, 100% small biz";
    expect(sanitize(clean)).toBe(clean);
  });

  it("caps output at the default field cap", () => {
    const long = "x".repeat(SANITIZE_FIELD_CAP + 500);
    expect(sanitize(long).length).toBe(SANITIZE_FIELD_CAP);
  });

  it("honors a custom maxLength", () => {
    expect(sanitize("abcdefgh", 4)).toBe("abcd");
  });
});
