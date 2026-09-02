/**
 * MANDATORY tenant isolation tests (CLAUDE.md section 7.2): two seeded
 * firms, zero cross-contamination through any of the four tools. Firm A's
 * token context must never surface firm B's deliverables, billing, usage,
 * or users, and vice versa.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { handleListDeliverables } from "../src/tools/list-deliverables.js";
import { handleGetBillingStatus } from "../src/tools/get-billing-status.js";
import { handleGetUsageSummary } from "../src/tools/get-usage-summary.js";
import { handleListUsers } from "../src/tools/list-users.js";
import type { ListDeliverablesPayload } from "../src/schemas/list-deliverables.js";
import type { GetBillingStatusPayload } from "../src/schemas/get-billing-status.js";
import type { GetUsageSummaryPayload } from "../src/schemas/get-usage-summary.js";
import type { ListUsersPayload } from "../src/schemas/list-users.js";
import {
  cleanupTenant,
  makeContext,
  parsePayload,
  prisma,
  seedTenant,
  shouldSkipIntegrationTests,
  type SeededTenant,
} from "./fixtures.js";

describe.skipIf(shouldSkipIntegrationTests())("tenant isolation, all four tools", () => {
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;

  beforeAll(async () => {
    tenantA = await seedTenant({
      label: "iso-A",
      tier: "PRO",
      withBilling: true,
      planName: "TENANT-A-SECRET plan",
      invoiceCount: 1,
      deliverables: [{ title: "TENANT-A-SECRET deliverable", daysUntilDue: 7 }],
      users: [{ firstName: "AlphaFirst", lastName: "AlphaLast", role: "ADMIN" }],
      usage: [{ provider: "claude", inputTokens: 111, outputTokens: 11, estimatedCostUsd: 0.11 }],
    });
    tenantB = await seedTenant({
      label: "iso-B",
      tier: "PRO",
      withBilling: true,
      planName: "TENANT-B-SECRET plan",
      invoiceCount: 4,
      deliverables: [
        { title: "TENANT-B-SECRET deliverable one", daysUntilDue: 3 },
        { title: "TENANT-B-SECRET deliverable two", daysUntilDue: 9 },
      ],
      users: [
        { firstName: "BravoFirst", lastName: "BravoLast", role: "ADMIN" },
        { firstName: "BravoSecond", lastName: "BravoLastTwo", role: "MEMBER" },
      ],
      usage: [
        { provider: "claude", inputTokens: 222, outputTokens: 22, estimatedCostUsd: 0.22 },
        { provider: "claude", inputTokens: 333, outputTokens: 33, estimatedCostUsd: 0.33 },
        { provider: "openai", inputTokens: 444, outputTokens: 44, estimatedCostUsd: 0.44 },
      ],
    });
  });

  afterAll(async () => {
    if (tenantA) await cleanupTenant(tenantA);
    if (tenantB) await cleanupTenant(tenantB);
    await prisma.$disconnect();
  });

  it("firm A cannot see firm B deliverables", async () => {
    const payload = parsePayload<ListDeliverablesPayload>(
      await handleListDeliverables({ limit: 100, offset: 0 }, makeContext(tenantA))
    );
    expect(payload.total).toBe(1);
    expect(payload.results[0]!.title).toContain("TENANT-A-SECRET");
    expect(payload.results.some((r) => r.title.includes("TENANT-B-SECRET"))).toBe(false);
    for (const row of payload.results) {
      expect(tenantB.deliverableIds.includes(row.id)).toBe(false);
    }
  });

  it("firm B cannot see firm A deliverables", async () => {
    const payload = parsePayload<ListDeliverablesPayload>(
      await handleListDeliverables({ limit: 100, offset: 0 }, makeContext(tenantB))
    );
    expect(payload.total).toBe(2);
    expect(payload.results.every((r) => r.title.includes("TENANT-B-SECRET"))).toBe(true);
    for (const row of payload.results) {
      expect(tenantA.deliverableIds.includes(row.id)).toBe(false);
    }
  });

  it("firm A cannot filter into firm B deliverables via client_company_id", async () => {
    const payload = parsePayload<ListDeliverablesPayload>(
      await handleListDeliverables(
        { client_company_id: tenantB.clientCompanyId, limit: 100, offset: 0 },
        makeContext(tenantA)
      )
    );
    // The tenant filter is ANDed first, so B's client id matches nothing.
    expect(payload.total).toBe(0);
    expect(payload.results).toEqual([]);
  });

  it("billing status is scoped to the calling firm", async () => {
    const a = parsePayload<GetBillingStatusPayload>(
      await handleGetBillingStatus({}, makeContext(tenantA))
    );
    const b = parsePayload<GetBillingStatusPayload>(
      await handleGetBillingStatus({}, makeContext(tenantB))
    );
    expect(a.plan!.name).toContain("TENANT-A-SECRET");
    expect(a.invoices.count).toBe(1);
    expect(a.invoices.latest!.invoice_number).toContain("iso-A");
    expect(b.plan!.name).toContain("TENANT-B-SECRET");
    expect(b.invoices.count).toBe(4);
    expect(b.invoices.latest!.invoice_number).toContain("iso-B");
  });

  it("usage summary aggregates only the calling firm's rows", async () => {
    const a = parsePayload<GetUsageSummaryPayload>(
      await handleGetUsageSummary({ window_days: 30 }, makeContext(tenantA))
    );
    const b = parsePayload<GetUsageSummaryPayload>(
      await handleGetUsageSummary({ window_days: 30 }, makeContext(tenantB))
    );
    expect(a.totals.calls).toBe(1);
    expect(a.totals.input_tokens).toBe(111);
    expect(b.totals.calls).toBe(3);
    expect(b.totals.input_tokens).toBe(222 + 333 + 444);
  });

  it("user listings never cross firms", async () => {
    const a = parsePayload<ListUsersPayload>(
      await handleListUsers({ include_emails: true, limit: 100, offset: 0 }, makeContext(tenantA))
    );
    const b = parsePayload<ListUsersPayload>(
      await handleListUsers({ include_emails: true, limit: 100, offset: 0 }, makeContext(tenantB))
    );
    expect(a.total).toBe(1);
    expect(a.results[0]!.first_name).toBe("AlphaFirst");
    expect(a.results.some((u) => u.first_name.startsWith("Bravo"))).toBe(false);
    expect(b.total).toBe(2);
    expect(b.results.every((u) => u.first_name.startsWith("Bravo"))).toBe(true);
    const aEmails = new Set(a.results.map((u) => u.email));
    for (const email of tenantB.userEmails) {
      expect(aEmails.has(email)).toBe(false);
    }
  });
});
