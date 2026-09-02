/**
 * Test fixtures for proposal-mcp integration tests.
 *
 * Tests run against the shared dev database. Every fixture row uses ids
 * (or names, where the column is a UUID) prefixed with
 * `proposal-mcp-test-<runid>-` so parallel test runs from sibling
 * servers never collide, and afterAll cleanup removes everything.
 *
 * Note on UUID columns: consulting_firms.id feeds mcp_audit_log.tenant_id
 * which is a Postgres UUID column, so firm and token ids must stay
 * database-generated UUIDs; the prefix goes on the firm name and contact
 * email instead. Opportunity, matrix, requirement, and adherence ids are
 * plain TEXT and carry the prefix directly.
 */
import crypto from "node:crypto";
import {
  createPrismaClient,
  createStderrLogger,
  hashToken,
  shouldSkipIntegrationTests as sharedShouldSkipIntegrationTests,
  type Logger,
  type PrismaLikeClient,
  type ResolvedTokenContext,
  type ToolHandlerContext,
} from "@bytescon/mcp-shared";

const RUN_ID = crypto.randomUUID().slice(0, 8);

export const TEST_PREFIX = `proposal-mcp-test-${RUN_ID}-`;

export const SERVER_NAME = "proposal-mcp";
export const SERVER_VERSION = "0.1.0";

/** Quiet logger for tests; errors only. */
export const testLogger: Logger = createStderrLogger("proposal-mcp-test", "error");

/** Audit row shape read back in assertions. */
export interface AuditRow {
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

/** Minimal structural view of the generated client used only by fixtures. */
interface FixtureDb {
  consultingFirm: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  };
  apiToken: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  };
  opportunity: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  };
  complianceMatrix: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  };
  matrixRequirement: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  };
  adherenceScore: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  };
  costVolume: {
    count(args: { where: Record<string, unknown> }): Promise<number>;
  };
  mcpAuditLog: {
    count(args: { where: Record<string, unknown> }): Promise<number>;
    findFirst(args: {
      where: Record<string, unknown>;
      orderBy: Record<string, "asc" | "desc">;
    }): Promise<AuditRow | null>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  };
  $disconnect(): Promise<void>;
}

/** Single shared client for all test files in a run. */
export const prismaTest = createPrismaClient() as unknown as FixtureDb & PrismaLikeClient;

export interface SeededTenant {
  label: string;
  firmId: string;
  rawToken: string;
  tokenId: string;
  tokenFp: string;
  /** Opportunity with a matrix, 5 requirements, guidance, and 2 adherence scores. */
  opportunityId: string;
  matrixId: string;
  /** Second opportunity whose matrix has no guidance and no requirements. */
  bareOpportunityId: string;
  bareMatrixId: string;
  requirementIds: string[];
  adherenceScoreIds: string[];
}

const REQUIREMENT_SEEDS = [
  { suffix: "req-1", section: "L.3.1", sectionType: "INSTRUCTION", status: "NOT_STARTED", isMandatory: true, farReference: null, sortOrder: 1 },
  { suffix: "req-2", section: "L.3.2", sectionType: "INSTRUCTION", status: "IN_PROGRESS", isMandatory: false, farReference: null, sortOrder: 2 },
  { suffix: "req-3", section: "M.2", sectionType: "EVALUATION", status: "COMPLETED", isMandatory: true, farReference: null, sortOrder: 3 },
  { suffix: "req-4", section: "I.1", sectionType: "CLAUSE", status: "NOT_STARTED", isMandatory: true, farReference: "52.219-14", sortOrder: 4 },
  { suffix: "req-5", section: "K.1", sectionType: "CERTIFICATION", status: "PENDING_REVIEW", isMandatory: true, farReference: null, sortOrder: 5 },
] as const;

export async function seedTenant(label: string): Promise<SeededTenant> {
  const firm = await prismaTest.consultingFirm.create({
    data: {
      name: `${TEST_PREFIX}${label}`,
      contactEmail: `${TEST_PREFIX}${label}@example.test`,
      isTest: true,
    },
  });

  const rawToken = `${TEST_PREFIX}token-${crypto.randomUUID()}`;
  const tokenHash = hashToken(rawToken);
  const token = await prismaTest.apiToken.create({
    data: {
      name: `${TEST_PREFIX}${label}-token`,
      consultingFirmId: firm.id,
      tokenHash,
      tokenPrefix: rawToken.slice(0, 8),
      tier: "CORE",
    },
  });

  const opportunityId = `${TEST_PREFIX}${label}-opp-1`;
  await prismaTest.opportunity.create({
    data: {
      id: opportunityId,
      consultingFirmId: firm.id,
      title: `${label}-SECRET-OPP proposal fixture opportunity`,
      agency: "Department of Veterans Affairs",
      naicsCode: "541512",
      setAsideType: "SDVOSB",
      status: "ACTIVE",
      estimatedValue: "2500000.00",
      postedDate: new Date(Date.now() - 86_400_000),
      responseDeadline: new Date(Date.now() + 30 * 86_400_000),
      probabilityScore: 0.5,
    },
  });

  const matrixId = `${TEST_PREFIX}${label}-matrix-1`;
  await prismaTest.complianceMatrix.create({
    data: {
      id: matrixId,
      opportunityId,
      consultingFirmId: firm.id,
      sourceText: `${label} fixture solicitation snippet`,
      bidGuidanceJson: {
        evaluationCriteria: [{ factor: "Technical", weight: "50 percent" }],
        winStrategy: `${label}-SECRET-GUIDANCE emphasize past performance and SDVOSB status`,
        redFlags: ["compressed turnaround"],
      },
      bidGuidanceAt: new Date(),
    },
  });

  const requirementIds: string[] = [];
  for (const seed of REQUIREMENT_SEEDS) {
    const id = `${TEST_PREFIX}${label}-${seed.suffix}`;
    await prismaTest.matrixRequirement.create({
      data: {
        id,
        matrixId,
        section: seed.section,
        sectionType: seed.sectionType,
        requirementText: `${label}-SECRET-REQ section ${seed.section} response requirement text`,
        status: seed.status,
        isMandatory: seed.isMandatory,
        farReference: seed.farReference,
        sortOrder: seed.sortOrder,
      },
    });
    requirementIds.push(id);
  }

  const bareOpportunityId = `${TEST_PREFIX}${label}-opp-2`;
  await prismaTest.opportunity.create({
    data: {
      id: bareOpportunityId,
      consultingFirmId: firm.id,
      title: `${label} bare fixture opportunity, matrix without guidance`,
      agency: "General Services Administration",
      naicsCode: "541330",
      setAsideType: "NONE",
      status: "ACTIVE",
      responseDeadline: new Date(Date.now() + 45 * 86_400_000),
      probabilityScore: 0.4,
    },
  });
  const bareMatrixId = `${TEST_PREFIX}${label}-matrix-2`;
  await prismaTest.complianceMatrix.create({
    data: {
      id: bareMatrixId,
      opportunityId: bareOpportunityId,
      consultingFirmId: firm.id,
    },
  });

  const adherenceScoreIds: string[] = [];
  const overallId = `${TEST_PREFIX}${label}-adherence-1`;
  await prismaTest.adherenceScore.create({
    data: {
      id: overallId,
      consultingFirmId: firm.id,
      opportunityId,
      proposalSectionId: null,
      overallScore: 82.5,
      requirementCoverage: 0.9,
      evaluationAlignment: 0.8,
      farClauseCoverage: 0.7,
      blockersJson: {
        blockers: [{ id: "b1", severity: "HIGH", note: `${label}-SECRET-BLOCKER missing key personnel resume` }],
      },
      computedAt: new Date(),
    },
  });
  adherenceScoreIds.push(overallId);
  const olderId = `${TEST_PREFIX}${label}-adherence-2`;
  await prismaTest.adherenceScore.create({
    data: {
      id: olderId,
      consultingFirmId: firm.id,
      opportunityId,
      proposalSectionId: null,
      overallScore: 74,
      requirementCoverage: 0.75,
      computedAt: new Date(Date.now() - 3_600_000),
    },
  });
  adherenceScoreIds.push(olderId);

  return {
    label,
    firmId: firm.id,
    rawToken,
    tokenId: token.id,
    tokenFp: tokenHash.slice(0, 16),
    opportunityId,
    matrixId,
    bareOpportunityId,
    bareMatrixId,
    requirementIds,
    adherenceScoreIds,
  };
}

export async function cleanupTenant(tenant: SeededTenant): Promise<void> {
  await prismaTest.mcpAuditLog.deleteMany({ where: { tenantId: tenant.firmId } });
  await prismaTest.matrixRequirement.deleteMany({
    where: { matrixId: { in: [tenant.matrixId, tenant.bareMatrixId] } },
  });
  await prismaTest.complianceMatrix.deleteMany({
    where: { id: { in: [tenant.matrixId, tenant.bareMatrixId] } },
  });
  await prismaTest.adherenceScore.deleteMany({ where: { id: { in: tenant.adherenceScoreIds } } });
  await prismaTest.opportunity.deleteMany({
    where: { id: { in: [tenant.opportunityId, tenant.bareOpportunityId] } },
  });
  await prismaTest.apiToken.deleteMany({ where: { id: tenant.tokenId } });
  await prismaTest.consultingFirm.deleteMany({ where: { id: tenant.firmId } });
}

export function ctxFor(tenant: SeededTenant): ResolvedTokenContext {
  return {
    tokenId: tenant.tokenId,
    tokenFp: tenant.tokenFp,
    consultingFirmId: tenant.firmId,
    tier: "CORE",
  };
}

export function contextFor(tenant: SeededTenant): ToolHandlerContext {
  return {
    ctx: ctxFor(tenant),
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    prisma: prismaTest,
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

/** Parse the JSON text of the first content block of a handler result. */
export function parsePayload<T>(result: {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}): T {
  const block = result.content[0];
  if (!block) throw new Error("handler returned no content blocks");
  return JSON.parse(block.text) as T;
}
