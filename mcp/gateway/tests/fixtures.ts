/**
 * Test fixtures for the multiplexed gateway integration tests.
 *
 * Runs against the dev database (same instance the servers use). Each run uses
 * a unique prefix and cleans up in afterAll. Tests skip cleanly when
 * DATABASE_URL is unset (loud-fail in CI via the shared integration gate).
 *
 * Seeds a ConsultingFirm + an api_tokens row at a chosen tier so the tests can
 * (a) drive raw-Bearer requests and (b) mint OAuth at+jwt access tokens whose
 * `sub` resolves to that row.
 */
import crypto from "node:crypto";
import {
  createPrismaClient,
  hashToken,
  type ApiTokenTier,
  type PrismaLikeClient,
} from "@bytescon/mcp-shared";

const RUN_ID = crypto.randomUUID().slice(0, 8);
export const TEST_PREFIX = `mcp-gw-test-${RUN_ID}-`;

// The gateway uses the shared loader; reuse the same client here so seeded rows
// are visible to the app under test (it caches on globalThis outside prod).
export const prisma = createPrismaClient() as PrismaLikeClient & {
  consultingFirm: { create(args: { data: Record<string, unknown> }): Promise<{ id: string }> };
  apiToken: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  };
  consultingFirmDelete: never;
  mcpAuditLog: { deleteMany(args: { where: Record<string, unknown> }): Promise<unknown> } & PrismaLikeClient["mcpAuditLog"];
};

// Cast for the delete helpers Prisma exposes but PrismaLikeClient does not type.
const db = prisma as unknown as {
  consultingFirm: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  };
  apiToken: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  };
  mcpAuditLog: { deleteMany(args: { where: Record<string, unknown> }): Promise<unknown> };
};

export interface SeededTenant {
  firmId: string;
  rawToken: string;
  tokenId: string;
  tokenFp: string;
  tier: ApiTokenTier;
}

export async function seedTenant(label: string, tier: ApiTokenTier = "CORE"): Promise<SeededTenant> {
  const firm = await db.consultingFirm.create({
    data: {
      name: `${TEST_PREFIX}${label}`,
      contactEmail: `${TEST_PREFIX}${label}@example.test`,
    },
  });

  const rawToken = `${TEST_PREFIX}token-${crypto.randomUUID()}`;
  const tokenHash = hashToken(rawToken);

  const token = await db.apiToken.create({
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
    tier,
  };
}

export async function cleanupTenant(tenant: SeededTenant): Promise<void> {
  await db.mcpAuditLog.deleteMany({ where: { tenantId: tenant.firmId } });
  await db.apiToken.deleteMany({ where: { id: tenant.tokenId } });
  await db.consultingFirm.deleteMany({ where: { id: tenant.firmId } });
}

let _warnedSkipOnce = false;

/** Whether DB-backed integration tests should be skipped this run. */
export function shouldSkipIntegrationTests(): boolean {
  if (process.env.DATABASE_URL) return false;
  const ci = process.env.CI;
  const inCi = ci !== undefined && ci !== "" && ci.toLowerCase() !== "false" && ci !== "0";
  if (inCi) {
    throw new Error(
      "DATABASE_URL is not set but CI is set: refusing to silently skip DB-backed " +
        "gateway integration tests. Set DATABASE_URL to a reachable Postgres instance."
    );
  }
  if (!_warnedSkipOnce) {
    _warnedSkipOnce = true;
    // eslint-disable-next-line no-console
    console.warn(
      "[mcp-gateway] DATABASE_URL is not set: skipping DB-backed integration tests. " +
        "These are NOT silently passing. Set DATABASE_URL locally to run them."
    );
  }
  return true;
}
