/**
 * Tests for `trigger_enrichment` (GB-107) per the suite DoD:
 *   (a) happy path queue, (b) input validation failure, (c) tenant isolation,
 *   (d) audit row assertion, plus GB-107-specific idempotency and the
 *   COMPLETED / missing-notice short-circuits.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { handleTriggerEnrichment } from "../src/tools/trigger-enrichment.js";
import {
  TriggerEnrichmentInput,
  type TriggerEnrichmentPayload,
} from "../src/schemas/trigger-enrichment.js";
import { prisma } from "../src/lib/prisma.js";
import {
  seedTenantV03,
  cleanupTenantV03,
  shouldSkipIntegrationTests,
  type SeededTenantV03,
} from "./fixtures-v03.js";

const SERVER_NAME = "opportunity-mcp";
const SERVER_VERSION = "0.4.0";

function ctxFor(tenant: SeededTenantV03) {
  return {
    ctx: {
      tokenId: tenant.tokenId,
      tokenFp: tenant.tokenFp,
      consultingFirmId: tenant.firmId,
      tier: "VAULT" as const,
    },
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
  };
}

function parsePayload(result: { content: Array<{ text: string }> }): TriggerEnrichmentPayload {
  return JSON.parse(result.content[0]!.text) as TriggerEnrichmentPayload;
}

describe("trigger_enrichment — input validation (unit)", () => {
  it("requires a uuid opportunity_id", () => {
    expect(() => TriggerEnrichmentInput.parse({})).toThrow();
    expect(() => TriggerEnrichmentInput.parse({ opportunity_id: "not-a-uuid" })).toThrow();
  });

  it("defaults priority to normal and rejects unknown values", () => {
    const parsed = TriggerEnrichmentInput.parse({ opportunity_id: crypto.randomUUID() });
    expect(parsed.priority).toBe("normal");
    expect(() =>
      TriggerEnrichmentInput.parse({ opportunity_id: crypto.randomUUID(), priority: "asap" }),
    ).toThrow();
  });
});

describe.skipIf(shouldSkipIntegrationTests())("trigger_enrichment — handler (integration)", () => {
  let tenantA: SeededTenantV03;
  let tenantB: SeededTenantV03;
  let queueableOppId: string;
  let completedOppId: string;
  let noNoticeOppId: string;

  beforeAll(async () => {
    tenantA = await seedTenantV03({
      firmLabel: "trigenrich-A",
      opportunities: [
        { agency: "DoD", naicsCode: "484121" },
        { agency: "DoD", naicsCode: "484121" },
        { agency: "GSA", naicsCode: "561720" },
      ],
    });
    tenantB = await seedTenantV03({
      firmLabel: "trigenrich-B",
      opportunities: [{ agency: "VA", naicsCode: "541512" }],
    });

    ;[queueableOppId, completedOppId, noNoticeOppId] = tenantA.opportunityIds;

    await prisma.opportunity.update({
      where: { id: queueableOppId },
      data: { samNoticeId: `gb107-test-${crypto.randomUUID().slice(0, 12)}` },
    });
    await prisma.opportunity.update({
      where: { id: completedOppId },
      data: {
        samNoticeId: `gb107-test-${crypto.randomUUID().slice(0, 12)}`,
        descriptionEnrichmentStatus: "COMPLETED",
        descriptionEnrichedAt: new Date(),
      },
    });
    // noNoticeOppId keeps samNoticeId null.
  });

  afterAll(async () => {
    await prisma.mcpAuditLog.deleteMany({
      where: { tenantId: { in: [tenantA.firmId, tenantB.firmId] }, toolName: "trigger_enrichment" },
    });
    if (tenantA) await cleanupTenantV03(tenantA);
    if (tenantB) await cleanupTenantV03(tenantB);
    await prisma.$disconnect();
  });

  it("queues a never-attempted opportunity and writes an audit row (happy path)", async () => {
    const result = await handleTriggerEnrichment(
      TriggerEnrichmentInput.parse({ opportunity_id: queueableOppId }),
      ctxFor(tenantA),
    );
    expect(result.isError).toBeFalsy();
    const payload = parsePayload(result as { content: Array<{ text: string }> });
    expect(payload.status).toBe("QUEUED");
    expect(payload.estimated_completion).not.toBeNull();

    const row = await prisma.opportunity.findUnique({
      where: { id: queueableOppId },
      select: { descriptionEnrichmentStatus: true },
    });
    expect(row?.descriptionEnrichmentStatus).toBe("QUEUED");

    const audit = await prisma.mcpAuditLog.findFirst({
      where: { tenantId: tenantA.firmId, toolName: "trigger_enrichment", outcome: "ok" },
      orderBy: { ts: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is idempotent: an already-QUEUED row stays queued without error", async () => {
    const result = await handleTriggerEnrichment(
      TriggerEnrichmentInput.parse({ opportunity_id: queueableOppId }),
      ctxFor(tenantA),
    );
    const payload = parsePayload(result as { content: Array<{ text: string }> });
    expect(payload.status).toBe("QUEUED");
    expect(payload.message).toContain("Already queued");
  });

  it("short-circuits COMPLETED rows without re-queueing", async () => {
    const result = await handleTriggerEnrichment(
      TriggerEnrichmentInput.parse({ opportunity_id: completedOppId }),
      ctxFor(tenantA),
    );
    const payload = parsePayload(result as { content: Array<{ text: string }> });
    expect(payload.status).toBe("COMPLETED");
    expect(payload.estimated_completion).toBeNull();

    const row = await prisma.opportunity.findUnique({
      where: { id: completedOppId },
      select: { descriptionEnrichmentStatus: true },
    });
    expect(row?.descriptionEnrichmentStatus).toBe("COMPLETED");
  });

  it("returns FAILED for opportunities without a SAM notice ID", async () => {
    const result = await handleTriggerEnrichment(
      TriggerEnrichmentInput.parse({ opportunity_id: noNoticeOppId }),
      ctxFor(tenantA),
    );
    const payload = parsePayload(result as { content: Array<{ text: string }> });
    expect(payload.status).toBe("FAILED");
    expect(payload.message).toContain("no SAM.gov notice ID");
  });

  it("enforces tenant isolation: tenant B cannot queue tenant A's opportunity", async () => {
    const result = await handleTriggerEnrichment(
      TriggerEnrichmentInput.parse({ opportunity_id: completedOppId }),
      ctxFor(tenantB),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not found");

    // And the cross-tenant row was not touched.
    const row = await prisma.opportunity.findUnique({
      where: { id: completedOppId },
      select: { descriptionEnrichmentStatus: true },
    });
    expect(row?.descriptionEnrichmentStatus).toBe("COMPLETED");
  });
});
