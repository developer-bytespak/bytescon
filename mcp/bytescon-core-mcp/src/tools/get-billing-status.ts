/**
 * `get_billing_status` tool handler.
 *
 * The tenant's Subscription plus SubscriptionPlan (name, billing cycle,
 * current period, status) plus an invoice summary (count, latest invoice
 * number, status, total). DATABASE ONLY: no Stripe API calls and no
 * payment-method data ever leave this tool. Stripe identifiers
 * (stripeCustomerId, stripeSubscriptionId) are intentionally never
 * selected.
 */
import { registerTool, sanitize, type HandlerResult, type ToolHandlerContext, type ToolRegistrar } from "@bytescon/mcp-shared";
import { coreDb, toNumber } from "../lib/db.js";
import { runTool } from "../lib/run-tool.js";
import {
  getBillingStatusInputShape,
  type GetBillingStatusInputT,
  type GetBillingStatusPayload,
} from "../schemas/get-billing-status.js";

const TOOL_NAME = "get_billing_status";

const TOOL_DESCRIPTION =
  "Get your tenant's subscription and billing status: plan name, billing cycle, current period, subscription status, " +
  "and an invoice summary with the latest invoice number, status, and total in USD. " +
  "Reads the platform database only; no payment processor calls and no payment-method data.";

/**
 * Pure handler, directly testable. The McpServer registration wraps this.
 */
export async function handleGetBillingStatus(
  input: GetBillingStatusInputT,
  context: ToolHandlerContext
): Promise<HandlerResult> {
  return runTool(TOOL_NAME, input, context, async () => {
    const db = coreDb(context.prisma);
    const consultingFirmId = context.ctx.consultingFirmId;

    const subscription = await db.subscription.findUnique({
      where: { consultingFirmId },
      select: {
        id: true,
        planId: true,
        status: true,
        billingCycle: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        cancelAtPeriodEnd: true,
        trialEndsAt: true,
      },
    });

    const plan = subscription
      ? await db.subscriptionPlan.findUnique({
          where: { id: subscription.planId },
          select: {
            name: true,
            slug: true,
            monthlyPriceUsd: true,
            annualPriceUsd: true,
            maxUsers: true,
            maxClients: true,
            aiCallsPerMonth: true,
          },
        })
      : null;

    const [invoiceCount, latestInvoice] = await Promise.all([
      db.invoice.count({ where: { consultingFirmId } }),
      db.invoice.findFirst({
        where: { consultingFirmId },
        orderBy: [{ createdAt: "desc" }],
        select: {
          invoiceNumber: true,
          status: true,
          totalUsd: true,
          periodStart: true,
          periodEnd: true,
          dueAt: true,
          paidAt: true,
          createdAt: true,
        },
      }),
    ]);

    const payload: GetBillingStatusPayload = {
      subscription: subscription
        ? {
            status: subscription.status,
            billing_cycle: subscription.billingCycle,
            current_period_start: subscription.currentPeriodStart.toISOString(),
            current_period_end: subscription.currentPeriodEnd.toISOString(),
            cancel_at_period_end: subscription.cancelAtPeriodEnd,
            trial_ends_at: subscription.trialEndsAt ? subscription.trialEndsAt.toISOString() : null,
          }
        : null,
      plan: plan
        ? {
            name: sanitize(plan.name, 200),
            slug: plan.slug,
            monthly_price_usd: toNumber(plan.monthlyPriceUsd),
            annual_price_usd: toNumber(plan.annualPriceUsd),
            max_users: plan.maxUsers,
            max_clients: plan.maxClients,
            ai_calls_per_month: plan.aiCallsPerMonth,
          }
        : null,
      invoices: {
        count: invoiceCount,
        latest: latestInvoice
          ? {
              invoice_number: latestInvoice.invoiceNumber,
              status: latestInvoice.status,
              total_usd: toNumber(latestInvoice.totalUsd),
              period_start: latestInvoice.periodStart.toISOString(),
              period_end: latestInvoice.periodEnd.toISOString(),
              due_at: latestInvoice.dueAt.toISOString(),
              paid_at: latestInvoice.paidAt ? latestInvoice.paidAt.toISOString() : null,
            }
          : null,
      },
    };
    return payload;
  });
}

export const registerGetBillingStatus: ToolRegistrar = (server, context) => {
  registerTool(server, {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    inputShape: getBillingStatusInputShape,
    handler: async (input) =>
      handleGetBillingStatus(input as unknown as GetBillingStatusInputT, context),
  });
};
