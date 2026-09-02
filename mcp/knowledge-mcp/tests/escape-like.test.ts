/**
 * escapeLike: unit coverage for the LIKE metacharacter escaper applied at
 * every Prisma `contains` / `startsWith` site in this server.
 */
import { describe, expect, it } from "vitest";
import { escapeLike } from "../src/lib/escape-like.js";

describe("escapeLike (unit)", () => {
  it("escapes percent signs", () => {
    expect(escapeLike("52%219")).toBe("52\\%219");
  });

  it("escapes underscores", () => {
    expect(escapeLike("____")).toBe("\\_\\_\\_\\_");
  });

  it("escapes backslashes so they cannot neutralize the escaping", () => {
    expect(escapeLike("a\\%b")).toBe("a\\\\\\%b");
  });

  it("leaves ordinary keywords and clause codes untouched", () => {
    expect(escapeLike("subcontracting")).toBe("subcontracting");
    expect(escapeLike("252.204-7012")).toBe("252.204-7012");
    expect(escapeLike("Department of Energy")).toBe("Department of Energy");
  });

  it("handles the empty string", () => {
    expect(escapeLike("")).toBe("");
  });
});
