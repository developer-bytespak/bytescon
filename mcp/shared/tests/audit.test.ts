import { describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "../src/lib/audit.js";
import { hashInput, writeAuditEntry } from "../src/lib/audit.js";
import type { Logger } from "../src/lib/logger.js";
import { makeMockPrisma, TEST_PREFIX } from "./helpers/mock-prisma.js";

function makeEntry(overrides?: Partial<AuditEntry>): AuditEntry {
  return {
    serverName: "shared-mcp-test-server",
    serverVersion: "0.1.0",
    toolName: "shared_mcp_test_tool",
    tenantId: `${TEST_PREFIX}tenant-id`,
    tokenFp: "0123456789abcdef",
    inputHash: "f".repeat(64),
    outputBytes: 128,
    durationMs: 12,
    outcome: "ok",
    ...overrides,
  };
}

describe("hashInput() - canonical JSON (unit)", () => {
  it("is deterministic across key orderings", () => {
    const a = hashInput({ keyword: "foo", limit: 10, set_aside: "SDVOSB" });
    const b = hashInput({ set_aside: "SDVOSB", limit: 10, keyword: "foo" });
    expect(a).toBe(b);
    expect(a.length).toBe(64);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles nested objects and arrays deterministically", () => {
    const a = hashInput({ a: 1, b: { x: 1, y: [{ q: 1, p: 2 }] } });
    const b = hashInput({ b: { y: [{ p: 2, q: 1 }], x: 1 }, a: 1 });
    expect(a).toBe(b);
  });

  it("distinguishes different inputs", () => {
    expect(hashInput({ keyword: "foo" })).not.toBe(hashInput({ keyword: "bar" }));
  });

  it("preserves array element order in the hash", () => {
    expect(hashInput({ list: [1, 2] })).not.toBe(hashInput({ list: [2, 1] }));
  });
});

describe("writeAuditEntry() with injected mock prisma (unit)", () => {
  it("writes exactly one row with mapped fields and null defaults", async () => {
    const prisma = makeMockPrisma();
    await writeAuditEntry(prisma, makeEntry());
    expect(prisma.mcpAuditLog.create).toHaveBeenCalledTimes(1);
    const arg = prisma.mcpAuditLog.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data).toEqual({
      serverName: "shared-mcp-test-server",
      serverVersion: "0.1.0",
      toolName: "shared_mcp_test_tool",
      tenantId: `${TEST_PREFIX}tenant-id`,
      userId: null,
      tokenFp: "0123456789abcdef",
      inputHash: "f".repeat(64),
      outputBytes: 128,
      durationMs: 12,
      outcome: "ok",
      correlationId: null,
      clientInfo: null,
    });
  });

  it("passes through optional userId, correlationId, and clientInfo", async () => {
    const prisma = makeMockPrisma();
    await writeAuditEntry(
      prisma,
      makeEntry({
        userId: `${TEST_PREFIX}user-id`,
        correlationId: `${TEST_PREFIX}corr-id`,
        clientInfo: { host: "claude-desktop" },
        outcome: "auth_error",
      })
    );
    const arg = prisma.mcpAuditLog.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data["userId"]).toBe(`${TEST_PREFIX}user-id`);
    expect(arg.data["correlationId"]).toBe(`${TEST_PREFIX}corr-id`);
    expect(arg.data["clientInfo"]).toEqual({ host: "claude-desktop" });
    expect(arg.data["outcome"]).toBe("auth_error");
  });

  it("rethrows on write failure and logs via the injected logger", async () => {
    const prisma = makeMockPrisma();
    prisma.mcpAuditLog.create.mockRejectedValue(new Error("insert denied"));
    const error = vi.fn();
    const logger = { error } as unknown as Logger;

    await expect(writeAuditEntry(prisma, makeEntry(), logger)).rejects.toThrow("insert denied");
    expect(error).toHaveBeenCalledTimes(1);
    const meta = error.mock.calls[0]![1] as Record<string, unknown>;
    expect(meta["err"]).toBe("insert denied");
    expect(meta["tool_name"]).toBe("shared_mcp_test_tool");
  });
});
