/**
 * Happy-path integration tests for the four bytescon-core-mcp handlers,
 * including the list_users privacy assertion (emails absent without the
 * include_emails flag) and the no-Stripe-data assertion on billing.
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

describe.skipIf(shouldSkipIntegrationTests())("bytescon-core-mcp handlers (integration)", () => {
  let tenant: SeededTenant;
  let bare: SeededTenant;

  beforeAll(async () => {
    tenant = await seedTenant({
      label: "handlers-A",
      tier: "PRO",
      withBilling: true,
      planName: "Vault Growth Plan",
      invoiceCount: 3,
      deliverables: [
        { title: "SF-1449 signature page", status: "PENDING", daysUntilDue: 5, penaltyAmount: 250.5 },
        { title: "Past performance volume", status: "SUBMITTED", daysUntilDue: 10 },
        { title: "Overdue insurance cert", status: "IN_PROGRESS", daysUntilDue: -2, penaltyAmount: 100 },
      ],
      users: [
        { firstName: "Ada", lastName: "Lovelace", role: "ADMIN", daysSinceLastLogin: 1 },
        { firstName: "Grace", lastName: "Hopper", role: "MEMBER" },
        { firstName: "Inactive", lastName: "Zperson", role: "MEMBER", isActive: false },
      ],
      usage: [
        { provider: "claude", inputTokens: 1000, outputTokens: 500, estimatedCostUsd: 0.25 },
        { provider: "claude", inputTokens: 2000, outputTokens: 1000, estimatedCostUsd: 0.5 },
        { provider: "openai", inputTokens: 300, outputTokens: 100, estimatedCostUsd: 0.05 },
        // Outside every window used in these tests.
        { provider: "claude", inputTokens: 9999, outputTokens: 9999, estimatedCostUsd: 9.99, daysAgo: 100 },
      ],
    });
    // Tenant with no billing rows, no users, no usage: empty-state checks.
    bare = await seedTenant({ label: "handlers-bare", tier: "PRO" });
  });

  afterAll(async () => {
    if (tenant) await cleanupTenant(tenant);
    if (bare) await cleanupTenant(bare);
    await prisma.$disconnect();
  });

  describe("list_deliverables", () => {
    it("returns the tenant's deliverables with due date and penalty fields", async () => {
      const result = await handleListDeliverables(
        { limit: 25, offset: 0 },
        makeContext(tenant)
      );
      expect(result.isError).toBeFalsy();
      const payload = parsePayload<ListDeliverablesPayload>(result);
      expect(payload.total).toBe(3);
      expect(payload.count).toBe(3);
      // Ordered by dueDate asc: the overdue one first.
      expect(payload.results[0]!.title).toContain("Overdue insurance cert");
      const sf1449 = payload.results.find((r) => r.title.includes("SF-1449"));
      expect(sf1449).toBeDefined();
      expect(sf1449!.penalty_amount).toBe(250.5);
      expect(sf1449!.status).toBe("PENDING");
      expect(Date.parse(sf1449!.due_date)).toBeGreaterThan(Date.now());
      expect(sf1449!.client_company_id).toBe(tenant.clientCompanyId);
    });

    it("filters by status", async () => {
      const result = await handleListDeliverables(
        { status: "SUBMITTED", limit: 25, offset: 0 },
        makeContext(tenant)
      );
      const payload = parsePayload<ListDeliverablesPayload>(result);
      expect(payload.count).toBe(1);
      expect(payload.results[0]!.title).toContain("Past performance");
    });

    it("filters by due_before", async () => {
      const result = await handleListDeliverables(
        { due_before: new Date().toISOString(), limit: 25, offset: 0 },
        makeContext(tenant)
      );
      const payload = parsePayload<ListDeliverablesPayload>(result);
      expect(payload.count).toBe(1);
      expect(payload.results[0]!.title).toContain("Overdue");
    });

    it("filters by client_company_id and paginates with offset/limit", async () => {
      const page1 = parsePayload<ListDeliverablesPayload>(
        await handleListDeliverables(
          { client_company_id: tenant.clientCompanyId, limit: 2, offset: 0 },
          makeContext(tenant)
        )
      );
      const page2 = parsePayload<ListDeliverablesPayload>(
        await handleListDeliverables(
          { client_company_id: tenant.clientCompanyId, limit: 2, offset: 2 },
          makeContext(tenant)
        )
      );
      expect(page1.total).toBe(3);
      expect(page1.count).toBe(2);
      expect(page2.count).toBe(1);
      const ids = new Set([...page1.results, ...page2.results].map((r) => r.id));
      expect(ids.size).toBe(3);
    });

    it("returns an empty result set for a tenant with no deliverables", async () => {
      const payload = parsePayload<ListDeliverablesPayload>(
        await handleListDeliverables({ limit: 25, offset: 0 }, makeContext(bare))
      );
      expect(payload.total).toBe(0);
      expect(payload.results).toEqual([]);
    });
  });

  describe("get_billing_status", () => {
    it("returns subscription, plan, and invoice summary from the DB", async () => {
      const result = await handleGetBillingStatus({}, makeContext(tenant));
      expect(result.isError).toBeFalsy();
      const payload = parsePayload<GetBillingStatusPayload>(result);
      expect(payload.subscription).not.toBeNull();
      expect(payload.subscription!.status).toBe("ACTIVE");
      expect(payload.subscription!.billing_cycle).toBe("MONTHLY");
      expect(Date.parse(payload.subscription!.current_period_end)).toBeGreaterThan(Date.now());
      expect(payload.plan).not.toBeNull();
      expect(payload.plan!.name).toBe("Vault Growth Plan");
      expect(payload.plan!.monthly_price_usd).toBe(499);
      expect(payload.invoices.count).toBe(3);
      expect(payload.invoices.latest).not.toBeNull();
      expect(payload.invoices.latest!.invoice_number).toContain("INV-002");
      expect(payload.invoices.latest!.status).toBe("OPEN");
      expect(payload.invoices.latest!.total_usd).toBe(499);
    });

    it("never exposes Stripe or payment-method data", async () => {
      const result = await handleGetBillingStatus({}, makeContext(tenant));
      const text = result.content[0]!.text.toLowerCase();
      expect(text).not.toContain("stripe");
      expect(text).not.toContain("card");
      expect(text).not.toContain("payment_method");
    });

    it("returns nulls and zero counts for a tenant without billing rows", async () => {
      const payload = parsePayload<GetBillingStatusPayload>(
        await handleGetBillingStatus({}, makeContext(bare))
      );
      expect(payload.subscription).toBeNull();
      expect(payload.plan).toBeNull();
      expect(payload.invoices.count).toBe(0);
      expect(payload.invoices.latest).toBeNull();
    });
  });

  describe("get_usage_summary", () => {
    it("aggregates calls, tokens, and cost by provider within the window", async () => {
      const result = await handleGetUsageSummary({ window_days: 30 }, makeContext(tenant));
      expect(result.isError).toBeFalsy();
      const payload = parsePayload<GetUsageSummaryPayload>(result);
      expect(payload.window_days).toBe(30);

      const claude = payload.providers.find((p) => p.provider === "claude");
      const openai = payload.providers.find((p) => p.provider === "openai");
      expect(claude).toBeDefined();
      expect(openai).toBeDefined();
      // The 100-days-ago row is excluded by the 30 day window.
      expect(claude!.calls).toBe(2);
      expect(claude!.input_tokens).toBe(3000);
      expect(claude!.output_tokens).toBe(1500);
      expect(claude!.estimated_cost_usd).toBeCloseTo(0.75, 6);
      expect(openai!.calls).toBe(1);
      expect(payload.totals.calls).toBe(3);
      expect(payload.totals.input_tokens).toBe(3300);
      expect(payload.totals.estimated_cost_usd).toBeCloseTo(0.8, 6);
    });

    it("widens the window to include older rows", async () => {
      const payload = parsePayload<GetUsageSummaryPayload>(
        await handleGetUsageSummary({ window_days: 365 }, makeContext(tenant))
      );
      const claude = payload.providers.find((p) => p.provider === "claude");
      expect(claude!.calls).toBe(3);
      expect(claude!.input_tokens).toBe(3000 + 9999);
    });

    it("returns empty providers for a tenant with no usage", async () => {
      const payload = parsePayload<GetUsageSummaryPayload>(
        await handleGetUsageSummary({ window_days: 30 }, makeContext(bare))
      );
      expect(payload.providers).toEqual([]);
      expect(payload.totals.calls).toBe(0);
    });
  });

  describe("list_users", () => {
    it("returns name, role, active flag, and last login", async () => {
      const result = await handleListUsers(
        { include_emails: false, limit: 25, offset: 0 },
        makeContext(tenant)
      );
      expect(result.isError).toBeFalsy();
      const payload = parsePayload<ListUsersPayload>(result);
      expect(payload.total).toBe(3);
      const ada = payload.results.find((u) => u.first_name === "Ada");
      expect(ada).toBeDefined();
      expect(ada!.last_name).toBe("Lovelace");
      expect(ada!.role).toBe("ADMIN");
      expect(ada!.is_active).toBe(true);
      expect(ada!.last_login_at).not.toBeNull();
      const inactive = payload.results.find((u) => u.last_name === "Zperson");
      expect(inactive!.is_active).toBe(false);
      expect(inactive!.last_login_at).toBeNull();
    });

    it("PRIVACY: omits the email field entirely when include_emails is false", async () => {
      const result = await handleListUsers(
        { include_emails: false, limit: 25, offset: 0 },
        makeContext(tenant)
      );
      const payload = parsePayload<ListUsersPayload>(result);
      for (const user of payload.results) {
        expect("email" in user).toBe(false);
      }
      // No seeded email address leaks anywhere in the serialized payload.
      const text = result.content[0]!.text;
      for (const email of tenant.userEmails) {
        expect(text).not.toContain(email);
      }
      expect(text).not.toContain("@example.test");
    });

    it("includes emails when include_emails is true and tier is PRO", async () => {
      const result = await handleListUsers(
        { include_emails: true, limit: 25, offset: 0 },
        makeContext(tenant)
      );
      expect(result.isError).toBeFalsy();
      const payload = parsePayload<ListUsersPayload>(result);
      const emails = payload.results.map((u) => u.email).sort();
      expect(emails).toEqual([...tenant.userEmails].sort());
    });

    it("paginates with offset/limit", async () => {
      const page = parsePayload<ListUsersPayload>(
        await handleListUsers({ include_emails: false, limit: 2, offset: 2 }, makeContext(tenant))
      );
      expect(page.total).toBe(3);
      expect(page.count).toBe(1);
    });
  });
});
