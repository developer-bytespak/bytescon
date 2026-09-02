/**
 * Test fixtures for opportunity-mcp integration tests.
 *
 * Tests run against the dev database (no isolated test DB in v0.1).
 * Fixtures use a unique prefix per run and clean up in afterAll. Tests
 * skip cleanly if DATABASE_URL is unset.
 */
import crypto from "node:crypto";
import { prisma } from "../src/lib/prisma.js";
import { hashToken } from "../src/lib/auth.js";

const RUN_ID = crypto.randomUUID().slice(0, 8);

export const TEST_PREFIX = `mcp-test-${RUN_ID}-`;

export interface SeededTenant {
  firmId: string;
  rawToken: string;
  tokenId: string;
  tokenFp: string;
  opportunityIds: string[];
}

interface SeedOptions {
  firmLabel: string;
  opportunities: Array<{
    title: string;
    agency: string;
    naicsCode: string;
    setAsideType?: string;
    daysUntilDeadline?: number;
    status?: "ACTIVE" | "ARCHIVED" | "EXPIRED" | "AWARDED";
    description?: string;
  }>;
}

export async function seedTenant(opts: SeedOptions): Promise<SeededTenant> {
  const firm = await prisma.consultingFirm.create({
    data: {
      name: `${TEST_PREFIX}${opts.firmLabel}`,
      contactEmail: `${TEST_PREFIX}${opts.firmLabel}@example.test`,
    },
  });

  const rawToken = `${TEST_PREFIX}token-${crypto.randomUUID()}`;
  const tokenHash = hashToken(rawToken);

  const token = await prisma.apiToken.create({
    data: {
      name: `${TEST_PREFIX}token`,
      consultingFirmId: firm.id,
      tokenHash,
      tokenPrefix: rawToken.slice(0, 8),
      tier: "CORE",
    },
  });

  const opportunityIds: string[] = [];
  for (const opp of opts.opportunities) {
    const daysOut = opp.daysUntilDeadline ?? 30;
    const created = await prisma.opportunity.create({
      data: {
        consultingFirmId: firm.id,
        title: opp.title,
        agency: opp.agency,
        naicsCode: opp.naicsCode,
        setAsideType: opp.setAsideType ?? "NONE",
        responseDeadline: new Date(Date.now() + daysOut * 86_400_000),
        postedDate: new Date(Date.now() - 86_400_000),
        status: opp.status ?? "ACTIVE",
        description: opp.description ?? null,
        probabilityScore: 0.5,
      },
    });
    opportunityIds.push(created.id);
  }

  return {
    firmId: firm.id,
    rawToken,
    tokenId: token.id,
    tokenFp: tokenHash.slice(0, 16),
    opportunityIds,
  };
}

export async function cleanupTenant(tenant: SeededTenant): Promise<void> {
  await prisma.mcpAuditLog.deleteMany({ where: { tenantId: tenant.firmId } });
  await prisma.opportunity.deleteMany({ where: { id: { in: tenant.opportunityIds } } });
  await prisma.apiToken.deleteMany({ where: { id: tenant.tokenId } });
  await prisma.consultingFirm.deleteMany({ where: { id: tenant.firmId } });
}

// opportunity-mcp predates @bytescon/mcp-shared and does not depend on it, so
// the loud-fail integration gate is replicated inline here (see
// mcp/shared/src/lib/integration-gate.ts for the shared implementation the
// other servers delegate to).
let _warnedSkipOnce = false;

/**
 * Whether DB-backed integration tests should be skipped this run.
 * Skips locally (with a visible one-time warning) when DATABASE_URL is
 * unset; throws in CI so a missing var fails loudly instead of silently
 * skipping; runs the tests when DATABASE_URL is set.
 */
export function shouldSkipIntegrationTests(): boolean {
  if (process.env.DATABASE_URL) return false;
  const ci = process.env.CI;
  const inCi = ci !== undefined && ci !== "" && ci.toLowerCase() !== "false" && ci !== "0";
  if (inCi) {
    throw new Error(
      "DATABASE_URL is not set but CI is set: refusing to silently skip DB-backed " +
        "integration tests. Set DATABASE_URL to a reachable Postgres instance " +
        "(see .github/workflows/ci.yml mcp job) and re-run."
    );
  }
  if (!_warnedSkipOnce) {
    _warnedSkipOnce = true;
    // eslint-disable-next-line no-console
    console.warn(
      "[opportunity-mcp] DATABASE_URL is not set: skipping DB-backed integration tests. " +
        "These are NOT silently passing. Set DATABASE_URL locally to run them."
    );
  }
  return true;
}
