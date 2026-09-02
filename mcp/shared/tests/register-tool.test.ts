import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerTool, type HandlerResult } from "../src/lib/register-tool.js";

const inputShape = {
  keyword: z.string().min(1).max(50).describe("Search keyword."),
  limit: z.number().int().min(1).max(25).default(10).describe("Max results, 1 to 25, default 10."),
};

describe("registerTool() (unit)", () => {
  it("registers via server.tool(name, description, shape, cb)", () => {
    const tool = vi.fn();
    const server = { tool } as unknown as McpServer;

    registerTool(server, {
      name: "shared_mcp_test_tool",
      description: "Test tool for the shared registration helper.",
      inputShape,
      handler: async () => ({ content: [{ type: "text", text: "{}" }] }),
    });

    expect(tool).toHaveBeenCalledTimes(1);
    const [name, description, shape, cb] = tool.mock.calls[0]!;
    expect(name).toBe("shared_mcp_test_tool");
    expect(description).toBe("Test tool for the shared registration helper.");
    expect(shape).toBe(inputShape);
    expect(typeof cb).toBe("function");
  });

  it("the registered callback forwards parsed input to the handler", async () => {
    const tool = vi.fn();
    const server = { tool } as unknown as McpServer;
    const handler = vi.fn(
      async (input: { keyword: string; limit: number }): Promise<HandlerResult> => ({
        content: [{ type: "text", text: JSON.stringify(input) }],
      })
    );

    registerTool(server, {
      name: "shared_mcp_test_tool",
      description: "Test tool.",
      inputShape,
      handler,
    });

    const cb = tool.mock.calls[0]![3] as (input: unknown) => Promise<HandlerResult>;
    const result = await cb({ keyword: "vets", limit: 5 });
    expect(handler).toHaveBeenCalledWith({ keyword: "vets", limit: 5 });
    expect(result.content[0]!.text).toBe('{"keyword":"vets","limit":5}');
  });

  it("works against a real McpServer instance without connecting", async () => {
    const { McpServer: RealMcpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new RealMcpServer({ name: "shared-mcp-test-server", version: "0.0.1" });
    expect(() =>
      registerTool(server, {
        name: "shared_mcp_test_real",
        description: "Registration smoke against the real SDK class.",
        inputShape,
        handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      })
    ).not.toThrow();
  });
});
