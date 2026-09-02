/**
 * Typed structural view over the injected Prisma client for the models
 * bytescon-core-mcp queries: DocumentRequirement, Subscription,
 * SubscriptionPlan, Invoice, ApiUsageLog, and User.
 *
 * @bytescon/mcp-shared's PrismaLikeClient deliberately covers only
 * api_tokens and mcp_audit_log; servers needing more models cast the
 * client to their own view (see mcp/shared/README.md, "Prisma client
 * strategy"). Field names below are verified against
 * backend/prisma/schema.prisma on 2026-06-11.
 *
 * All access is READ-ONLY: the only methods exposed are findMany,
 * findUnique, findFirst, count, and groupBy. The audit append happens
 * through the shared PrismaLikeClient surface, never through this view.
 */
import type { PrismaLikeClient } from "@bytescon/mcp-shared";

/**
 * Prisma Decimal columns arrive as Decimal objects (which implement
 * toString()); accept primitives too so tests can use plain numbers.
 */
export type DecimalLike = { toString(): string } | number | string;

/**
 * Convert a Prisma Decimal-ish value to a finite number, or null.
 *
 * @param value - Decimal object, number, string, null, or undefined.
 * @returns Finite number, or null when absent or not numeric.
 */
export function toNumber(value: DecimalLike | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(typeof value === "object" ? value.toString() : value);
  return Number.isFinite(n) ? n : null;
}

/** document_requirements columns selected by list_deliverables. */
export interface DeliverableRow {
  id: string;
  clientCompanyId: string;
  opportunityId: string | null;
  title: string;
  description: string | null;
  dueDate: Date;
  isPenaltyEnabled: boolean;
  penaltyAmount: DecimalLike | null;
  penaltyPercent: DecimalLike | null;
  status: string;
  submittedAt: Date | null;
}

/** subscriptions columns selected by get_billing_status. */
export interface SubscriptionRow {
  id: string;
  planId: string;
  status: string;
  billingCycle: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: Date | null;
}

/** subscription_plans columns selected by get_billing_status. */
export interface SubscriptionPlanRow {
  name: string;
  slug: string;
  monthlyPriceUsd: DecimalLike;
  annualPriceUsd: DecimalLike;
  maxUsers: number;
  maxClients: number;
  aiCallsPerMonth: number;
}

/** invoices columns selected by get_billing_status. */
export interface InvoiceRow {
  invoiceNumber: string;
  status: string;
  totalUsd: DecimalLike;
  periodStart: Date;
  periodEnd: Date;
  dueAt: Date;
  paidAt: Date | null;
  createdAt: Date;
}

/** api_usage_logs groupBy(provider) row used by get_usage_summary. */
export interface UsageGroupRow {
  provider: string;
  _count: { _all: number };
  _sum: {
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedCostUsd: DecimalLike | null;
  };
}

/** users columns selected by list_users (email only when requested). */
export interface UserRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  isActive: boolean;
  lastLoginAt: Date | null;
}

/** Read-only model surface used by the four bytescon-core-mcp tools. */
export interface CoreDb {
  documentRequirement: {
    findMany(args: Record<string, unknown>): Promise<DeliverableRow[]>;
    count(args: Record<string, unknown>): Promise<number>;
  };
  subscription: {
    findUnique(args: Record<string, unknown>): Promise<SubscriptionRow | null>;
  };
  subscriptionPlan: {
    findUnique(args: Record<string, unknown>): Promise<SubscriptionPlanRow | null>;
  };
  invoice: {
    count(args: Record<string, unknown>): Promise<number>;
    findFirst(args: Record<string, unknown>): Promise<InvoiceRow | null>;
  };
  apiUsageLog: {
    groupBy(args: Record<string, unknown>): Promise<UsageGroupRow[]>;
  };
  user: {
    findMany(args: Record<string, unknown>): Promise<UserRow[]>;
    count(args: Record<string, unknown>): Promise<number>;
  };
}

/**
 * Cast the shared injected client to the bytescon-core-mcp model view.
 *
 * @param prisma - The injected client from ToolHandlerContext.
 * @returns The same client, typed for this server's read-only queries.
 */
export function coreDb(prisma: PrismaLikeClient): CoreDb {
  return prisma as unknown as CoreDb;
}
