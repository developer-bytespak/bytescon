/**
 * Test fixtures for knowledge-mcp integration tests.
 *
 * Tests run against the shared local dev database. Every fixture id is
 * prefixed with `knowledge-mcp-test-<run id>-` so parallel test runs of
 * sibling servers never collide, and everything is removed in afterAll.
 * Tests skip cleanly when DATABASE_URL is unset.
 *
 * The clause catalog rows applied by scripts/seed-clause-catalog.sql
 * (54 FAR + 15 DFARS, global reference data) are READ by tests but never
 * modified or deleted.
 */
import crypto from "node:crypto";
import {
  createPrismaClient,
  hashToken,
  shouldSkipIntegrationTests as sharedShouldSkipIntegrationTests,
  type ApiTokenTier,
  type PrismaLikeClient,
  type ResolvedTokenContext,
  type ToolHandlerContext,
} from "@bytescon/mcp-shared";
import winston from "winston";

const RUN_ID = crypto.randomUUID().slice(0, 8);

export const TEST_PREFIX = `knowledge-mcp-test-${RUN_ID}-`;

export const SERVER_NAME = "knowledge-mcp";
export const SERVER_VERSION = "0.1.0";

/** Structural view of the generated client covering test seeding needs. */
export interface TestPrismaClient extends PrismaLikeClient {
  consultingFirm: {
    create(args: { data: { name: string; contactEmail: string } }): Promise<{ id: string }>;
    deleteMany(args: { where: { id: string } }): Promise<unknown>;
  };
  apiToken: PrismaLikeClient["apiToken"] & {
    create(args: {
      data: {
        name: string;
        consultingFirmId: string;
        tokenHash: string;
        tokenPrefix: string;
        tier: ApiTokenTier;
        revokedAt?: Date;
        expiresAt?: Date;
      };
    }): Promise<{ id: string }>;
    deleteMany(args: { where: { id: string } }): Promise<unknown>;
  };
  mcpAuditLog: PrismaLikeClient["mcpAuditLog"] & {
    count(args: { where: { tenantId: string } }): Promise<number>;
    findFirst(args: {
      where: { tenantId: string };
      orderBy: { ts: "desc" };
    }): Promise<{
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
    } | null>;
    deleteMany(args: { where: { tenantId: string } }): Promise<unknown>;
  };
  farClause: {
    create(args: {
      data: {
        id: string;
        code: string;
        partNumber: string;
        title: string;
        summary?: string;
        text?: string;
        tags?: string[];
      };
    }): Promise<{ id: string }>;
    deleteMany(args: { where: { id: { startsWith: string } } }): Promise<unknown>;
  };
  dfarsClause: {
    create(args: {
      data: {
        id: string;
        code: string;
        partNumber: string;
        title: string;
        summary?: string;
        text?: string;
        tags?: string[];
      };
    }): Promise<{ id: string }>;
    deleteMany(args: { where: { id: { startsWith: string } } }): Promise<unknown>;
  };
  agencyAwardProfile: {
    create(args: {
      data: {
        id: string;
        agencyName: string;
        avgAwardValue?: number;
        smallBizRate?: number;
        sdvosbRate?: number;
        totalAwards?: number;
        typicalNaics?: string[];
      };
    }): Promise<{ id: string }>;
    deleteMany(args: { where: { id: { startsWith: string } } }): Promise<unknown>;
  };
  opportunity: {
    create(args: {
      data: {
        consultingFirmId: string;
        title: string;
        agency: string;
        naicsCode: string;
        responseDeadline: Date;
      };
    }): Promise<{ id: string }>;
    deleteMany(args: { where: { id: { in: string[] } } }): Promise<unknown>;
  };
}

export const prisma: TestPrismaClient = createPrismaClient() as TestPrismaClient;

/** Silent logger so test output stays readable. */
export const testLogger = winston.createLogger({
  silent: true,
  transports: [new winston.transports.Console({ stderrLevels: [] })],
});

export interface SeededTenant {
  firmId: string;
  rawToken: string;
  tokenId: string;
  tokenFp: string;
}

/**
 * Seed one consulting firm plus an api token.
 *
 * @param firmLabel - Distinguishes firms within a run; prefixed automatically.
 * @param tier - Token tier, defaults to CORE (the server minimum).
 */
export async function seedTenant(
  firmLabel: string,
  tier: ApiTokenTier = "CORE"
): Promise<SeededTenant> {
  const firm = await prisma.consultingFirm.create({
    data: {
      name: `${TEST_PREFIX}${firmLabel}`,
      contactEmail: `${TEST_PREFIX}${firmLabel}@example.test`,
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
      tier,
    },
  });

  return {
    firmId: firm.id,
    rawToken,
    tokenId: token.id,
    tokenFp: tokenHash.slice(0, 16),
  };
}

/** Remove a seeded tenant and its audit rows. */
export async function cleanupTenant(tenant: SeededTenant): Promise<void> {
  await prisma.mcpAuditLog.deleteMany({ where: { tenantId: tenant.firmId } });
  await prisma.apiToken.deleteMany({ where: { id: tenant.tokenId } });
  await prisma.consultingFirm.deleteMany({ where: { id: tenant.firmId } });
}

/** Build a ResolvedTokenContext for a seeded tenant. */
export function ctxFor(tenant: SeededTenant, tier: ApiTokenTier = "CORE"): ResolvedTokenContext {
  return {
    tokenId: tenant.tokenId,
    tokenFp: tenant.tokenFp,
    consultingFirmId: tenant.firmId,
    tier,
  };
}

/** Build the full ToolHandlerContext handlers receive at registration. */
export function handlerContext(ctx: ResolvedTokenContext): ToolHandlerContext {
  return {
    ctx,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    prisma,
    logger: testLogger,
  };
}

/**
 * Delegates to the shared gate: skip locally when DATABASE_URL is unset
 * (with a visible warning), but fail loudly when CI is set and the var is
 * missing instead of skipping silently.
 */
export function shouldSkipIntegrationTests(): boolean {
  return sharedShouldSkipIntegrationTests();
}
