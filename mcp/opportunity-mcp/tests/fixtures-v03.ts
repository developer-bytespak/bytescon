/**
 * Test fixtures for the v0.3 tool additions (forecast_revenue,
 * list_set_asides, list_agencies_by_naics).
 *
 * Tests run against the shared dev database. Per the suite contract,
 * fixture labels are prefixed with the SERVER name plus a per-run id
 * ("opportunity-mcp-test-<runid>-") so parallel test runs from other
 * workstreams on the same database never collide. Everything seeded
 * here is removed in afterAll via the cleanup helpers.
 */
import crypto from "node:crypto";
import { prisma } from "../src/lib/prisma.js";
import { hashToken } from "../src/lib/auth.js";
import { shouldSkipIntegrationTests as canonicalShouldSkipIntegrationTests } from "./fixtures.js";

const RUN_ID = crypto.randomUUID().slice(0, 8);

export const TEST_PREFIX_V03 = `opportunity-mcp-test-${RUN_ID}-`;

export interface SeededTenantV03 {
  firmId: string;
  rawToken: string;
  tokenId: string;
  tokenFp: string;
  opportunityIds: string[];
}

export interface SeedOpportunityV03 {
  title?: string;
  agency: string;
  naicsCode: string;
  setAsideType?: string;
  daysUntilDeadline?: number;
  status?: "ACTIVE" | "ARCHIVED" | "EXPIRED" | "AWARDED";
  estimatedValue?: number;
  probabilityScore?: number;
  recompeteFlag?: boolean;
  incumbentProbability?: number;
}

interface SeedOptionsV03 {
  firmLabel: string;
  opportunities: SeedOpportunityV03[];
}

export async function seedTenantV03(opts: SeedOptionsV03): Promise<SeededTenantV03> {
  const firm = await prisma.consultingFirm.create({
    data: {
      name: `${TEST_PREFIX_V03}${opts.firmLabel}`,
      contactEmail: `${TEST_PREFIX_V03}${opts.firmLabel}@example.test`,
    },
  });

  const rawToken = `${TEST_PREFIX_V03}token-${crypto.randomUUID()}`;
  const tokenHash = hashToken(rawToken);

  const token = await prisma.apiToken.create({
    data: {
      name: `${TEST_PREFIX_V03}token`,
      consultingFirmId: firm.id,
      tokenHash,
      tokenPrefix: rawToken.slice(0, 8),
      tier: "VAULT",
    },
  });

  const opportunityIds: string[] = [];
  for (const opp of opts.opportunities) {
    const daysOut = opp.daysUntilDeadline ?? 30;
    const created = await prisma.opportunity.create({
      data: {
        consultingFirmId: firm.id,
        title: opp.title ?? `${TEST_PREFIX_V03}opportunity`,
        agency: opp.agency,
        naicsCode: opp.naicsCode,
        setAsideType: opp.setAsideType ?? "NONE",
        responseDeadline: new Date(Date.now() + daysOut * 86_400_000),
        postedDate: new Date(Date.now() - 86_400_000),
        status: opp.status ?? "ACTIVE",
        probabilityScore: opp.probabilityScore ?? 0.5,
        ...(opp.estimatedValue != null ? { estimatedValue: opp.estimatedValue } : {}),
        ...(opp.recompeteFlag != null ? { recompeteFlag: opp.recompeteFlag } : {}),
        // != null (not truthy) so a seeded value of exactly 0 is persisted.
        ...(opp.incumbentProbability != null
          ? { incumbentProbability: opp.incumbentProbability }
          : {}),
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

export async function cleanupTenantV03(tenant: SeededTenantV03): Promise<void> {
  await prisma.mcpAuditLog.deleteMany({ where: { tenantId: tenant.firmId } });
  await prisma.opportunity.deleteMany({ where: { id: { in: tenant.opportunityIds } } });
  await prisma.apiToken.deleteMany({ where: { id: tenant.tokenId } });
  await prisma.consultingFirm.deleteMany({ where: { id: tenant.firmId } });
}

export interface SeededAgencyProfile {
  id: string;
  agencyName: string;
}

/**
 * AgencyAwardProfile is GLOBAL (unique on agencyName), so fixture
 * profiles must carry the run prefix in their agency name and be
 * deleted in afterAll.
 */
export async function seedAgencyProfile(opts: {
  agencyName: string;
  avgAwardValue?: number;
  smallBizRate?: number;
  sdvosbRate?: number;
}): Promise<SeededAgencyProfile> {
  const row = await prisma.agencyAwardProfile.create({
    data: {
      agencyName: opts.agencyName,
      ...(opts.avgAwardValue != null ? { avgAwardValue: opts.avgAwardValue } : {}),
      ...(opts.smallBizRate != null ? { smallBizRate: opts.smallBizRate } : {}),
      ...(opts.sdvosbRate != null ? { sdvosbRate: opts.sdvosbRate } : {}),
    },
  });
  return { id: row.id, agencyName: row.agencyName };
}

export async function cleanupAgencyProfiles(profiles: SeededAgencyProfile[]): Promise<void> {
  if (profiles.length === 0) return;
  await prisma.agencyAwardProfile.deleteMany({
    where: { id: { in: profiles.map((p) => p.id) } },
  });
}

/** Delegates to the canonical loud-fail gate in fixtures.ts. */
export function shouldSkipIntegrationTests(): boolean {
  return canonicalShouldSkipIntegrationTests();
}
