/**
 * End-to-end tests for installValidationAudit (CLAUDE.md section 4.1 item 6).
 *
 * These drive a REAL tools/call over the SDK's InMemoryTransport + Client
 * against an McpServer built with the same sequence bootstrapStdioServer
 * uses (registerTool for each tool, then installValidationAudit), so the
 * actual SDK Zod-validation path and the actual wrapper are exercised. No
 * database is touched: an injected mock Prisma records audit writes, matching
 * the existing shared unit-test style (helpers/mock-prisma.ts).
 *
 * Coverage:
 *   (a) the host receives the validation error,
 *   (b) exactly one audit row with outcome "validation_error" is written,
 *   (c) a VALID call records exactly one row (the handler's), not two,
 *   (d) an audit-write failure does not change the host-visible response.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { installValidationAudit } from "../src/lib/install-validation-audit.js";
import { registerTool } from "../src/lib/register-tool.js";
import type { Logger } from "../src/lib/logger.js";
import { makeMockPrisma, TEST_PREFIX, type MockPrisma } from "./helpers/mock-prisma.js";

const SERVER_NAME = "shared-mcp-test-server";
const SERVER_VERSION = "0.2.0";

const TENANT_ID = `${TEST_PREFIX}tenant-id`;
const TOKEN_FP = "0123456789abcdef";

const echoShape = {
  // limit must be an int 1..25, so a string or 0 is a validation rejection.
  limit: z.number().int().min(1).max(25).describe("Max results, 1 to 25."),
};

/** A silent logger so test output stays clean while still being a real shape. */
function silentLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

/**
 * Build a connected client/server pair the way the bootstrap does: register
 * one tool whose handler writes its own success audit row (mirroring the
 * per-tool run-tool envelope), then install the validation-audit wrapper.
 */
async function buildPair(
  prisma: MockPrisma,
  logger: Logger
): Promise<{ client: Client; server: McpServer }> {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // The handler audits its own success exactly like run-tool.ts does, so a
  // valid call already produces one row independent of the wrapper.
  registerTool(server, {
    name: "echo_limit",
    description: "Echo the validated limit back. Used to exercise the validation-audit wrapper.",
    inputShape: echoShape,
    handler: async (input) => {
      await prisma.mcpAuditLog.create({
        data: {
          serverName: SERVER_NAME,
          serverVersion: SERVER_VERSION,
          toolName: "echo_limit",
          tenantId: TENANT_ID,
          userId: null,
          tokenFp: TOKEN_FP,
          inputHash: "f".repeat(64),
          outputBytes: 8,
          durationMs: 1,
          outcome: "ok",
          correlationId: null,
          clientInfo: null,
        },
      });
      return { content: [{ type: "text", text: JSON.stringify({ limit: input.limit }) }] };
    },
  });

  installValidationAudit(server, {
    tenantId: TENANT_ID,
    tokenFp: TOKEN_FP,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    prisma,
    logger,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "shared-mcp-test-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("installValidationAudit() end-to-end over InMemoryTransport", () => {
  let open: McpServer | undefined;

  afterEach(async () => {
    if (open) {
      await open.close().catch(() => undefined);
      open = undefined;
    }
  });

  it("(a)+(b) host gets the validation error and exactly one validation_error row is written", async () => {
    const prisma = makeMockPrisma();
    const logger = silentLogger();
    const { client, server } = await buildPair(prisma, logger);
    open = server;

    // limit: 0 violates min(1) -> SDK rejects before the handler runs.
    const result = (await client.callTool({ name: "echo_limit", arguments: { limit: 0 } })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };

    // (a) the host receives the structured validation error. The SDK wraps
    // the message as "MCP error -32602: Input validation error: ...".
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Input validation error:");
    expect(result.content[0]!.text).toContain("echo_limit");

    // (b) exactly one audit row, with outcome validation_error, for echo_limit.
    expect(prisma.mcpAuditLog.create).toHaveBeenCalledTimes(1);
    const data = prisma.mcpAuditLog.create.mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data["outcome"]).toBe("validation_error");
    expect(data["toolName"]).toBe("echo_limit");
    expect(data["tenantId"]).toBe(TENANT_ID);
    expect(data["tokenFp"]).toBe(TOKEN_FP);
    expect(data["outputBytes"]).toBe(0);
    // Raw arguments are never persisted: only a 64-char canonical hash.
    expect(String(data["inputHash"])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("(c) a VALID call records exactly one row (the handler's), not two", async () => {
    const prisma = makeMockPrisma();
    const logger = silentLogger();
    const { client, server } = await buildPair(prisma, logger);
    open = server;

    const result = (await client.callTool({ name: "echo_limit", arguments: { limit: 5 } })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe('{"limit":5}');

    // Exactly one row, written by the handler with outcome "ok". The wrapper
    // must NOT add a second row on the success path.
    expect(prisma.mcpAuditLog.create).toHaveBeenCalledTimes(1);
    const data = prisma.mcpAuditLog.create.mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data["outcome"]).toBe("ok");
  });

  it("(d) an audit-write failure does not change the host-visible response", async () => {
    const prisma = makeMockPrisma();
    // The validation-audit write rejects; the wrapper must swallow it.
    prisma.mcpAuditLog.create.mockRejectedValue(new Error("insert denied"));
    const logger = silentLogger();
    const { client, server } = await buildPair(prisma, logger);
    open = server;

    const result = (await client.callTool({ name: "echo_limit", arguments: { limit: 99 } })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };

    // Host still sees the identical validation error, unchanged.
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Input validation error:");
    // The failure was logged, not thrown.
    expect((logger.error as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});
