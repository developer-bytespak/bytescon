/**
 * Test fixtures for bytescon-core-mcp integration tests.
 *
 * Tests run against the shared dev database (no isolated test DB in
 * v0.1). Every fixture row id and unique value carries the
 * `bytescon-core-mcp-test-<runid>-` prefix so parallel test runs from the
 * other suite workstreams never collide and cleanup is targeted.
 *
 * Exception: ConsultingFirm ids must be real UUIDs because
 * mcp_audit_log.tenant_id is a Postgres UUID column; the firm's name and
 * contactEmail carry the test prefix instead, and all child rows hang off
 * the firm id for cleanup.
 *
 * Token rows are minted exactly like opportunity-mcp's fixtures: raw
 * token -> SHA-256 via the shared hashToken() -> api_tokens.tokenHash,
 * with tokenPrefix = first 8 chars of the raw token.
 */
import crypto from "node:crypto";
import {
  createPrismaClient,
  createStderrLogger,
  hashToken,
  shouldSkipIntegrationTests as sharedShouldSkipIntegrationTests,
  type ApiTokenTier,
  type PrismaLikeClient,
  type ToolHandlerContext,
} from "@bytescon/mcp-shared";

const RUN_ID = crypto.randomUUID().slice(0, 8);

export const TEST_PREFIX = `bytescon-core-mcp-test-${RUN_ID}-`;

export const SERVER_NAME = "bytescon-core-mcp";
export const SERVER_VERSION = "0.1.0";

/** One shared client per test run (the backend-generated Prisma client). */
export const prisma: PrismaLikeClient = createPrismaClient();

/** Quiet logger so test output stays readable. */
export const testLogger = createStderrLogger("bytescon-core-mcp-test", "error");

/** Audit row shape read back in assertions. */
export interface AuditRowView {
  serverName: string;
  serverVersion: string;
  toolName: string;
  tenantId: string;
  tokenFp: string;
  inputHash: string;
  outputBytes: number;
  durationMs: number;
  outcome: string;
  correlationId: string | null;
}

/**
 * Loose structural view of the generated client covering exactly the
 * fixture writes and assertion reads these tests perform.
 */
export interface FixtureDb {
  consultingFirm: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  };
  user: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  };
  clientCompany: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  };
  documentRequirement: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  };
  subscriptionPlan: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  };
  subscription: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  };
  invoice: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  };
  apiUsageLog: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  };
  apiToken: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  };
  mcpAuditLog: {
    count(args: { where: Record<string, unknown> }): Promise<number>;
    findFirst(args: Record<string, unknown>): Promise<AuditRowView | null>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  };
}

export const db: FixtureDb = prisma as unknown as FixtureDb;

export interface SeedUserSpec {
  firstName: string;
  lastName: string;
  role?: string;
  isActive?: boolean;
  daysSinceLastLogin?: number;
}

export interface SeedDeliverableSpec {
  title: string;
  status?: "PENDING" | "IN_PROGRESS" | "SUBMITTED" | "APPROVED" | "REJECTED";
  daysUntilDue?: number;
  penaltyAmount?: number;
  description?: string;
}

export interface SeedUsageSpec {
  provider: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  daysAgo?: number;
}

export interface SeedOptions {
  label: string;
  tier?: ApiTokenTier;
  users?: SeedUserSpec[];
  deliverables?: SeedDeliverableSpec[];
  usage?: SeedUsageSpec[];
  withBilling?: boolean;
  planName?: string;
  invoiceCount?: number;
}

export interface SeededTenant {
  firmId: string;
  label: string;
  rawToken: string;
  tokenId: string;
  tokenFp: string;
  tier: ApiTokenTier;
  clientCompanyId: string;
  deliverableIds: string[];
  userIds: string[];
  userEmails: string[];
  usageIds: string[];
  planId: string | null;
  subscriptionId: string | null;
  invoiceIds: string[];
}

const DAY_MS = 86_400_000;

export async function seedTenant(opts: SeedOptions): Promise<SeededTenant> {
  const idBase = `${TEST_PREFIX}${opts.label}`;
  const tier: ApiTokenTier = opts.tier ?? "PRO";

  // Firm id must be a UUID (mcp_audit_log.tenant_id is @db.Uuid).
  const firm = await db.consultingFirm.create({
    data: {
      id: crypto.randomUUID(),
      name: `${idBase}-firm`,
      contactEmail: `${idBase}-firm@example.test`,
      isTest: true,
    },
  });

  const rawToken = `${idBase}-token-${crypto.randomUUID()}`;
  const tokenHash = hashToken(rawToken);
  const token = await db.apiToken.create({
    data: {
      id: `${idBase}-token-id`,
      name: `${idBase}-token`,
      consultingFirmId: firm.id,
      tokenHash,
      tokenPrefix: rawToken.slice(0, 8),
      tier,
    },
  });

  const client = await db.clientCompany.create({
    data: {
      id: `${idBase}-client`,
      consultingFirmId: firm.id,
      name: `${idBase}-client-co`,
    },
  });

  const deliverableIds: string[] = [];
  for (const [i, d] of (opts.deliverables ?? []).entries()) {
    const created = await db.documentRequirement.create({
      data: {
        id: `${idBase}-deliv-${i}`,
        consultingFirmId: firm.id,
        clientCompanyId: client.id,
        title: d.title,
        description: d.description ?? null,
        dueDate: new Date(Date.now() + (d.daysUntilDue ?? 30) * DAY_MS),
        status: d.status ?? "PENDING",
        penaltyAmount: d.penaltyAmount ?? null,
      },
    });
    deliverableIds.push(created.id);
  }

  const userIds: string[] = [];
  const userEmails: string[] = [];
  for (const [i, u] of (opts.users ?? []).entries()) {
    const email = `${idBase}-u${i}@example.test`;
    const created = await db.user.create({
      data: {
        id: `${idBase}-user-${i}`,
        consultingFirmId: firm.id,
        email,
        passwordHash: `${TEST_PREFIX}not-a-real-hash`,
        firstName: u.firstName,
        lastName: u.lastName,
        role: u.role ?? "MEMBER",
        isActive: u.isActive ?? true,
        lastLoginAt:
          u.daysSinceLastLogin !== undefined
            ? new Date(Date.now() - u.daysSinceLastLogin * DAY_MS)
            : null,
      },
    });
    userIds.push(created.id);
    userEmails.push(email);
  }

  const usageIds: string[] = [];
  for (const [i, usage] of (opts.usage ?? []).entries()) {
    const created = await db.apiUsageLog.create({
      data: {
        id: `${idBase}-usage-${i}`,
        consultingFirmId: firm.id,
        provider: usage.provider,
        model: `${idBase}-model`,
        task: "DOCUMENT_ANALYSIS",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimatedCostUsd: usage.estimatedCostUsd,
        createdAt: new Date(Date.now() - (usage.daysAgo ?? 0) * DAY_MS),
      },
    });
    usageIds.push(created.id);
  }

  let planId: string | null = null;
  let subscriptionId: string | null = null;
  const invoiceIds: string[] = [];
  if (opts.withBilling) {
    const plan = await db.subscriptionPlan.create({
      data: {
        id: `${idBase}-plan`,
        name: opts.planName ?? `${idBase}-plan-name`,
        slug: `${idBase}-plan`,
        monthlyPriceUsd: 499,
        annualPriceUsd: 4990,
        maxUsers: 10,
        maxClients: 25,
        aiCallsPerMonth: 1000,
        features: ["mcp-suite"],
        isActive: true,
      },
    });
    planId = plan.id;

    const sub = await db.subscription.create({
      data: {
        id: `${idBase}-sub`,
        consultingFirmId: firm.id,
        planId: plan.id,
        status: "ACTIVE",
        billingCycle: "MONTHLY",
        currentPeriodStart: new Date(Date.now() - 10 * DAY_MS),
        currentPeriodEnd: new Date(Date.now() + 20 * DAY_MS),
      },
    });
    subscriptionId = sub.id;

    const count = opts.invoiceCount ?? 2;
    for (let i = 0; i < count; i++) {
      const created = await db.invoice.create({
        data: {
          id: `${idBase}-inv-${i}`,
          consultingFirmId: firm.id,
          subscriptionId: sub.id,
          invoiceNumber: `${idBase}-INV-${String(i).padStart(3, "0")}`,
          status: i === count - 1 ? "OPEN" : "PAID",
          periodStart: new Date(Date.now() - (count - i) * 30 * DAY_MS),
          periodEnd: new Date(Date.now() - (count - i - 1) * 30 * DAY_MS),
          subtotalUsd: 499,
          taxUsd: 0,
          totalUsd: 499,
          paidAt: i === count - 1 ? null : new Date(Date.now() - (count - i - 1) * 30 * DAY_MS),
          dueAt: new Date(Date.now() + 15 * DAY_MS),
          // Deterministic recency: the last-created invoice is the newest.
          createdAt: new Date(Date.now() - (count - i) * DAY_MS),
        },
      });
      invoiceIds.push(created.id);
    }
  }

  return {
    firmId: firm.id,
    label: opts.label,
    rawToken,
    tokenId: token.id,
    tokenFp: tokenHash.slice(0, 16),
    tier,
    clientCompanyId: client.id,
    deliverableIds,
    userIds,
    userEmails,
    usageIds,
    planId,
    subscriptionId,
    invoiceIds,
  };
}

export async function cleanupTenant(tenant: SeededTenant): Promise<void> {
  await db.mcpAuditLog.deleteMany({ where: { tenantId: tenant.firmId } });
  await db.apiUsageLog.deleteMany({ where: { consultingFirmId: tenant.firmId } });
  await db.invoice.deleteMany({ where: { consultingFirmId: tenant.firmId } });
  await db.subscription.deleteMany({ where: { consultingFirmId: tenant.firmId } });
  await db.documentRequirement.deleteMany({ where: { consultingFirmId: tenant.firmId } });
  await db.user.deleteMany({ where: { consultingFirmId: tenant.firmId } });
  await db.clientCompany.deleteMany({ where: { consultingFirmId: tenant.firmId } });
  await db.apiToken.deleteMany({ where: { consultingFirmId: tenant.firmId } });
  await db.consultingFirm.deleteMany({ where: { id: tenant.firmId } });
  if (tenant.planId) {
    await db.subscriptionPlan.deleteMany({ where: { id: tenant.planId } });
  }
}

/**
 * Build the ToolHandlerContext handlers expect, from a seeded tenant.
 *
 * @param tenant - The seeded tenant.
 * @param overrides - Optional ctx/prisma overrides (e.g. a failing client
 *   for error-path tests, or a forced tier).
 */
export function makeContext(
  tenant: SeededTenant,
  overrides?: { tier?: ApiTokenTier; prisma?: PrismaLikeClient }
): ToolHandlerContext {
  return {
    ctx: {
      tokenId: tenant.tokenId,
      tokenFp: tenant.tokenFp,
      consultingFirmId: tenant.firmId,
      tier: overrides?.tier ?? tenant.tier,
    },
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    prisma: overrides?.prisma ?? prisma,
    logger: testLogger,
  };
}

/** Parse the JSON payload out of a HandlerResult's first text block. */
export function parsePayload<T>(result: { content: Array<{ type: "text"; text: string }> }): T {
  const first = result.content[0];
  if (!first) throw new Error("handler returned no content");
  return JSON.parse(first.text) as T;
}

/**
 * Delegates to the shared gate: skip locally when DATABASE_URL is unset
 * (with a visible warning), but fail loudly when CI is set and the var is
 * missing instead of skipping silently.
 */
export function shouldSkipIntegrationTests(): boolean {
  return sharedShouldSkipIntegrationTests();
}
