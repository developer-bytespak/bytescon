/**
 * Test fixtures for the past-performance tools (list_past_performance,
 * get_past_performance_detail).
 *
 * Tests run against the shared dev database. Per the suite contract,
 * fixture labels are prefixed with the SERVER name plus a per-run id
 * ("opportunity-mcp-pp-test-<runid>-") so parallel test runs from other
 * workstreams on the same database never collide. Everything seeded here
 * is removed in afterAll via cleanupTenantPp.
 */
import crypto from "node:crypto";
import { prisma } from "../src/lib/prisma.js";
import { hashToken } from "../src/lib/auth.js";
import { shouldSkipIntegrationTests as canonicalShouldSkipIntegrationTests } from "./fixtures.js";

const RUN_ID = crypto.randomUUID().slice(0, 8);

export const TEST_PREFIX_PP = `opportunity-mcp-pp-test-${RUN_ID}-`;

export interface SeededClient {
  id: string;
  name: string;
}

export interface SeededPpRecord {
  id: string;
  contractNumber: string;
  isCurrent: boolean;
  clientCompanyId: string | null;
}

export interface SeededTenantPp {
  firmId: string;
  rawToken: string;
  tokenId: string;
  tokenFp: string;
  clients: SeededClient[];
  records: SeededPpRecord[];
}

export interface SeedPpRecordInput {
  contractNumber: string;
  customerName: string;
  customerAgency?: string;
  contractType?: string;
  totalValue?: number;
  cparsRating?: string;
  cparsLink?: string;
  scopeSummary?: string;
  relevanceTags?: string[];
  isCurrent?: boolean;
  /** Tie this record to a seeded client by its label (see clientLabels). */
  clientLabel?: string;
}

interface SeedOptionsPp {
  firmLabel: string;
  /** Client-company labels to seed for this firm; referenced by SeedPpRecordInput.clientLabel. */
  clientLabels?: string[];
  records: SeedPpRecordInput[];
}

export async function seedTenantPp(opts: SeedOptionsPp): Promise<SeededTenantPp> {
  const firm = await prisma.consultingFirm.create({
    data: {
      name: `${TEST_PREFIX_PP}${opts.firmLabel}`,
      contactEmail: `${TEST_PREFIX_PP}${opts.firmLabel}@example.test`,
    },
  });

  const rawToken = `${TEST_PREFIX_PP}token-${crypto.randomUUID()}`;
  const tokenHash = hashToken(rawToken);

  const token = await prisma.apiToken.create({
    data: {
      name: `${TEST_PREFIX_PP}token`,
      consultingFirmId: firm.id,
      tokenHash,
      tokenPrefix: rawToken.slice(0, 8),
      tier: "VAULT",
    },
  });

  const clients: SeededClient[] = [];
  const clientIdByLabel = new Map<string, string>();
  for (const label of opts.clientLabels ?? []) {
    const client = await prisma.clientCompany.create({
      data: {
        consultingFirmId: firm.id,
        name: `${TEST_PREFIX_PP}${label}`,
      },
    });
    clients.push({ id: client.id, name: client.name });
    clientIdByLabel.set(label, client.id);
  }

  const records: SeededPpRecord[] = [];
  for (const rec of opts.records) {
    const clientCompanyId = rec.clientLabel ? clientIdByLabel.get(rec.clientLabel) ?? null : null;
    const created = await prisma.pastPerformanceRecord.create({
      data: {
        consultingFirmId: firm.id,
        contractNumber: `${TEST_PREFIX_PP}${rec.contractNumber}`,
        customerName: rec.customerName,
        ...(rec.customerAgency != null ? { customerAgency: rec.customerAgency } : {}),
        ...(rec.contractType != null ? { contractType: rec.contractType } : {}),
        ...(rec.totalValue != null ? { totalValue: rec.totalValue } : {}),
        ...(rec.cparsRating != null ? { cparsRating: rec.cparsRating } : {}),
        ...(rec.cparsLink != null ? { cparsLink: rec.cparsLink } : {}),
        ...(rec.scopeSummary != null ? { scopeSummary: rec.scopeSummary } : {}),
        ...(rec.relevanceTags != null ? { relevanceTags: rec.relevanceTags } : {}),
        // != null so a seeded value of exactly false is persisted.
        ...(rec.isCurrent != null ? { isCurrent: rec.isCurrent } : {}),
        ...(clientCompanyId ? { clientCompanyId } : {}),
      },
    });
    records.push({
      id: created.id,
      contractNumber: created.contractNumber,
      isCurrent: created.isCurrent,
      clientCompanyId: created.clientCompanyId,
    });
  }

  return {
    firmId: firm.id,
    rawToken,
    tokenId: token.id,
    tokenFp: tokenHash.slice(0, 16),
    clients,
    records,
  };
}

export async function cleanupTenantPp(tenant: SeededTenantPp): Promise<void> {
  await prisma.mcpAuditLog.deleteMany({ where: { tenantId: tenant.firmId } });
  await prisma.pastPerformanceRecord.deleteMany({
    where: { id: { in: tenant.records.map((r) => r.id) } },
  });
  await prisma.clientCompany.deleteMany({
    where: { id: { in: tenant.clients.map((c) => c.id) } },
  });
  await prisma.apiToken.deleteMany({ where: { id: tenant.tokenId } });
  await prisma.consultingFirm.deleteMany({ where: { id: tenant.firmId } });
}

/** Delegates to the canonical loud-fail gate in fixtures.ts. */
export function shouldSkipIntegrationTests(): boolean {
  return canonicalShouldSkipIntegrationTests();
}
