/**
 * Unit tests for the deep JSON sanitizer used on bidGuidanceJson and
 * blockersJson. No database required.
 */
import { describe, expect, it } from "vitest";
import { sanitizeJsonDeep } from "../src/lib/sanitize-json.js";

describe("sanitizeJsonDeep (unit)", () => {
  it("strips control characters from string leaves", () => {
    const dirty = "win" + String.fromCharCode(0) + "strategy" + String.fromCharCode(0x1f);
    const out = sanitizeJsonDeep({ a: dirty }) as { a: string };
    expect(out.a).toBe("win strategy ");
  });

  it("caps string leaves at the field cap", () => {
    const out = sanitizeJsonDeep({ a: "x".repeat(5000) }, 100) as { a: string };
    expect(out.a).toHaveLength(100);
  });

  it("preserves numbers, booleans, and nulls", () => {
    const out = sanitizeJsonDeep({ n: 42, b: true, z: null }) as Record<string, unknown>;
    expect(out).toEqual({ n: 42, b: true, z: null });
  });

  it("bounds array length and object key count", () => {
    const bigArray = Array.from({ length: 200 }, (_, i) => i);
    const bigObject: Record<string, number> = {};
    for (let i = 0; i < 200; i++) bigObject[`k${i}`] = i;
    const out = sanitizeJsonDeep({ arr: bigArray, obj: bigObject }) as {
      arr: number[];
      obj: Record<string, number>;
    };
    expect(out.arr).toHaveLength(50);
    expect(Object.keys(out.obj)).toHaveLength(50);
  });

  it("bounds recursion depth to null instead of recursing forever", () => {
    let nested: Record<string, unknown> = { leaf: "deep" };
    for (let i = 0; i < 20; i++) nested = { child: nested };
    const out = JSON.stringify(sanitizeJsonDeep(nested));
    expect(out).not.toContain("deep");
    expect(out).toContain("null");
  });

  it("converts non-JSON types to null", () => {
    const out = sanitizeJsonDeep({ big: BigInt(7), fn: () => 1 }) as Record<string, unknown>;
    expect(out["big"]).toBeNull();
    expect(out["fn"]).toBeNull();
  });
});
