/**
 * `get_usage_summary` tool handler.
 *
 * ApiUsageLog aggregates for the tenant: call counts, input/output
 * tokens, and estimated cost in USD grouped by provider over a sliding
 * window (default 30 days). Pure DB aggregate via groupBy; no provider
 * API calls.
 */
import { registerTool, sanitize, type HandlerResult, type ToolHandlerContext, type ToolRegistrar } from "@bytescon/mcp-shared";
import { coreDb, toNumber } from "../lib/db.js";
import { runTool } from "../lib/run-tool.js";
import {
  getUsageSummaryInputShape,
  type GetUsageSummaryInputT,
  type GetUsageSummaryPayload,
  type ProviderUsage,
} from "../schemas/get-usage-summary.js";

const TOOL_NAME = "get_usage_summary";

const TOOL_DESCRIPTION =
  "Summarize your tenant's AI API usage over a recent window: call counts, input and output tokens, " +
  "and estimated cost in USD, grouped by provider. window_days is 1 to 365, default 30.";

const DAY_MS = 86_400_000;

/** Round to 6 decimal places, matching the estimatedCostUsd column scale. */
function roundCost(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Pure handler, directly testable. The McpServer registration wraps this.
 */
export async function handleGetUsageSummary(
  input: GetUsageSummaryInputT,
  context: ToolHandlerContext
): Promise<HandlerResult> {
  return runTool(TOOL_NAME, input, context, async () => {
    const db = coreDb(context.prisma);
    const since = new Date(Date.now() - input.window_days * DAY_MS);

    const groups = await db.apiUsageLog.groupBy({
      by: ["provider"],
      where: {
        consultingFirmId: context.ctx.consultingFirmId,
        createdAt: { gte: since },
      },
      _count: { _all: true },
      _sum: {
        inputTokens: true,
        outputTokens: true,
        estimatedCostUsd: true,
      },
    });

    const providers: ProviderUsage[] = groups
      .map((g) => ({
        provider: sanitize(g.provider, 100),
        calls: g._count._all,
        input_tokens: g._sum.inputTokens ?? 0,
        output_tokens: g._sum.outputTokens ?? 0,
        estimated_cost_usd: roundCost(toNumber(g._sum.estimatedCostUsd) ?? 0),
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider));

    const totals = providers.reduce(
      (acc, p) => ({
        calls: acc.calls + p.calls,
        input_tokens: acc.input_tokens + p.input_tokens,
        output_tokens: acc.output_tokens + p.output_tokens,
        estimated_cost_usd: roundCost(acc.estimated_cost_usd + p.estimated_cost_usd),
      }),
      { calls: 0, input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0 }
    );

    const payload: GetUsageSummaryPayload = {
      window_days: input.window_days,
      since: since.toISOString(),
      providers,
      totals,
    };
    return payload;
  });
}

export const registerGetUsageSummary: ToolRegistrar = (server, context) => {
  registerTool(server, {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    inputShape: getUsageSummaryInputShape,
    handler: async (input) =>
      handleGetUsageSummary(input as unknown as GetUsageSummaryInputT, context),
  });
};
