/**
 * Validation-rejection audit test for the opportunity-mcp HTTP path.
 *
 * The runtime HTTP path (shared bootstrapHttpServer) installs the SHARED
 * `installValidationAudit` wrapper after registering each request's tools.
 * This test reproduces that exact sequence — build a per-request McpServer,
 * register a tool with opportunity's real list_clients shape, then install the
 * SHARED wrapper with an INJECTED mock prisma/logger — and drives a REAL
 * invalid tools/call over the SDK InMemoryTransport + Client. That exercises
 * the same wrapper the HTTP path installs at runtime and proves it audits a
 * validation rejection through the shared audit writer that actually runs in
 * prod (no database is touched; the injected mock records the write).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installValidationAudit } from "@bytescon/mcp-shared";
import { listClientsInputShape } from "../src/schemas/list-clients.js";

const auditCreate = vi.fn().mockResolvedValue({ id: 1n });
const loggerError = vi.fn();

// The shared wrapper takes prisma + logger INJECTED via its context (no module
// singletons to mock); the mock records the audit write the wrapper performs.
const mockPrisma = {
  mcpAuditLog: { create: auditCreate },
} as unknown as Parameters<typeof installValidationAudit>[1]["prisma"];
const mockLogger = { info: vi.fn(), warn: vi.fn(), error: loggerError, debug: vi.fn() };

const SERVER_NAME = "opportunity-mcp";
const SERVER_VERSION = "0.3.0";

const CTX = {
  tenantId: "opportunity-mcp-test-firm-id",
  tokenFp: "0123456789abcdef",
  serverName: SERVER_NAME,
  serverVersion: SERVER_VERSION,
  prisma: mockPrisma,
  logger: mockLogger,
};

describe("opportunity-mcp HTTP path: shared installValidationAudit", () => {
  let open: McpServer | undefined;

  afterEach(async () => {
    auditCreate.mockClear();
    auditCreate.mockResolvedValue({ id: 1n });
    loggerError.mockClear();
    if (open) {
      await open.close().catch(() => undefined);
      open = undefined;
    }
  });

  it("audits a validation rejection with outcome validation_error and returns the error unchanged", async () => {
    // Reproduce the HTTP path: fresh McpServer, register a tool with the real
    // list_clients shape, then install the shared validation-audit wrapper.
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    server.tool(
      "list_clients",
      "List the calling tenant's client companies.",
      listClientsInputShape,
      async () => ({ content: [{ type: "text", text: "{}" }] })
    );
    installValidationAudit(server, CTX);
    open = server;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "opportunity-mcp-test-client", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // limit: 0 violates min(1) -> SDK rejects before the handler runs.
    const result = (await client.callTool({
      name: "list_clients",
      arguments: { limit: 0 },
    })) as { isError?: boolean; content: Array<{ type: string; text: string }> };

    // Host receives the structured validation error unchanged.
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Input validation error:");
    expect(result.content[0]!.text).toContain("list_clients");

    // Exactly one audit row, outcome validation_error, tenant + fingerprint
    // from ctx, no raw arguments (only the canonical hash).
    expect(auditCreate).toHaveBeenCalledTimes(1);
    const data = auditCreate.mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data["outcome"]).toBe("validation_error");
    expect(data["toolName"]).toBe("list_clients");
    expect(data["tenantId"]).toBe(CTX.tenantId);
    expect(data["tokenFp"]).toBe(CTX.tokenFp);
    expect(data["outputBytes"]).toBe(0);
    expect(String(data["inputHash"])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a validation-audit write failure does not change the host-visible response", async () => {
    auditCreate.mockRejectedValueOnce(new Error("insert denied"));

    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    server.tool(
      "list_clients",
      "List the calling tenant's client companies.",
      listClientsInputShape,
      async () => ({ content: [{ type: "text", text: "{}" }] })
    );
    installValidationAudit(server, CTX);
    open = server;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "opportunity-mcp-test-client", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = (await client.callTool({
      name: "list_clients",
      arguments: { limit: 0 },
    })) as { isError?: boolean; content: Array<{ type: string; text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Input validation error:");
    expect(loggerError).toHaveBeenCalled();
  });
});
