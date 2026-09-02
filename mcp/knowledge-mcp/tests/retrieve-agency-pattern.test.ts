/**
 * retrieve_agency_pattern: input validation (unit), handler happy path
 * against a fixture AgencyAwardProfile + fixture opportunities, the
 * counts-only no-leak guarantee, and audit assertions.
 */
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleRetrieveAgencyPattern } from "../src/tools/retrieve-agency-pattern.js";
import { RetrieveAgencyPatternInput } from "../src/schemas/retrieve-agency-pattern.js";
import {
  TEST_PREFIX,
  cleanupTenant,
  ctxFor,
  handlerContext,
  prisma,
  shouldSkipIntegrationTests,
  type SeededTenant,
  seedTenant,
} from "./fixtures.js";

describe("retrieve_agency_pattern input validation (unit)", () => {
  it("accepts a normal agency fragment", () => {
    expect(RetrieveAgencyPatternInput.parse({ agency: "Veterans" }).agency).toBe("Veterans");
  });

  it("rejects agency under 2 chars", () => {
    expect(() => RetrieveAgencyPatternInput.parse({ agency: "V" })).toThrow();
    expect(() => RetrieveAgencyPatternInput.parse({ agency: "" })).toThrow();
  });

  it("rejects agency over 100 chars", () => {
    expect(() => RetrieveAgencyPatternInput.parse({ agency: "x".repeat(101) })).toThrow();
  });
});

describe.skipIf(shouldSkipIntegrationTests())(
  "retrieve_agency_pattern handler (integration)",
  () => {
    let tenant: SeededTenant;
    const agencyName = `${TEST_PREFIX}Test Agency Of Knowledge`;
    const profileId = `${TEST_PREFIX}agency-profile`;
    const opportunityIds: string[] = [];

    beforeAll(async () => {
      tenant = await seedTenant("agency-pattern");
      await prisma.agencyAwardProfile.create({
        data: {
          id: profileId,
          agencyName,
          avgAwardValue: 1234567,
          smallBizRate: 0.33,
          sdvosbRate: 0.12,
          totalAwards: 42,
          typicalNaics: ["541330", "541512"],
        },
      });
      // Three opportunities under the fixture agency: two in 541512, one
      // in 541330, so the top NAICS ordering is deterministic.
      const secret = `${TEST_PREFIX}SECRET-TITLE-${crypto.randomUUID().slice(0, 6)}`;
      const specs = [
        { naics: "541512", title: `${secret}-a` },
        { naics: "541512", title: `${secret}-b` },
        { naics: "541330", title: `${secret}-c` },
      ];
      for (const spec of specs) {
        const created = await prisma.opportunity.create({
          data: {
            consultingFirmId: tenant.firmId,
            title: spec.title,
            agency: agencyName,
            naicsCode: spec.naics,
            responseDeadline: new Date(Date.now() + 30 * 86_400_000),
          },
        });
        opportunityIds.push(created.id);
      }
    });

    afterAll(async () => {
      if (opportunityIds.length > 0) {
        await prisma.opportunity.deleteMany({ where: { id: { in: opportunityIds } } });
      }
      await prisma.agencyAwardProfile.deleteMany({ where: { id: { startsWith: TEST_PREFIX } } });
      if (tenant) await cleanupTenant(tenant);
    });

    it("returns matching agency profiles with award pattern fields", async () => {
      const result = await handleRetrieveAgencyPattern(
        { agency: agencyName },
        handlerContext(ctxFor(tenant))
      );
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0]!.text) as {
        profile_match_count: number;
        profile_matches: Array<Record<string, unknown>>;
      };
      expect(payload.profile_match_count).toBe(1);
      const match = payload.profile_matches[0]!;
      expect(match["agency_name"]).toBe(agencyName);
      expect(match["avg_award_value"]).toBe(1234567);
      expect(match["small_biz_rate"]).toBe(0.33);
      expect(match["sdvosb_rate"]).toBe(0.12);
      expect(match["total_awards"]).toBe(42);
    });

    it("treats LIKE metacharacters in the agency fragment literally", async () => {
      // Unescaped, the '%' would wildcard-match the fixture agency
      // ("...Test Agency Of Knowledge") via ILIKE '%...Test%Knowledge%'.
      const wildcardFragment = `${TEST_PREFIX}Test%Knowledge`;
      const result = await handleRetrieveAgencyPattern(
        { agency: wildcardFragment },
        handlerContext(ctxFor(tenant))
      );
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0]!.text) as {
        profile_match_count: number;
        top_naics_by_opportunity_count: unknown[];
      };
      expect(payload.profile_match_count).toBe(0);
      expect(payload.top_naics_by_opportunity_count).toEqual([]);
    });

    it("matches case-insensitively on a fragment", async () => {
      const fragment = agencyName.slice(4, 30).toUpperCase();
      const result = await handleRetrieveAgencyPattern(
        { agency: fragment },
        handlerContext(ctxFor(tenant))
      );
      const payload = JSON.parse(result.content[0]!.text) as {
        profile_matches: Array<Record<string, unknown>>;
      };
      expect(payload.profile_matches.some((m) => m["agency_name"] === agencyName)).toBe(true);
    });

    it("returns top NAICS as counts ordered by opportunity count", async () => {
      const result = await handleRetrieveAgencyPattern(
        { agency: agencyName },
        handlerContext(ctxFor(tenant))
      );
      const payload = JSON.parse(result.content[0]!.text) as {
        top_naics_by_opportunity_count: Array<{ naics: string; opportunity_count: number }>;
      };
      expect(payload.top_naics_by_opportunity_count.length).toBe(2);
      expect(payload.top_naics_by_opportunity_count[0]).toEqual({
        naics: "541512",
        opportunity_count: 2,
      });
      expect(payload.top_naics_by_opportunity_count[1]).toEqual({
        naics: "541330",
        opportunity_count: 1,
      });
    });

    it("never exposes opportunity titles, ids, or any tenant row content", async () => {
      const result = await handleRetrieveAgencyPattern(
        { agency: agencyName },
        handlerContext(ctxFor(tenant))
      );
      const text = result.content[0]!.text;
      expect(text).not.toContain("SECRET-TITLE");
      for (const id of opportunityIds) {
        expect(text).not.toContain(id);
      }
      const payload = JSON.parse(text) as {
        top_naics_by_opportunity_count: Array<Record<string, unknown>>;
      };
      for (const row of payload.top_naics_by_opportunity_count) {
        expect(Object.keys(row).sort()).toEqual(["naics", "opportunity_count"]);
      }
    });

    it("writes exactly one audit row per call with outcome ok", async () => {
      const before = await prisma.mcpAuditLog.count({ where: { tenantId: tenant.firmId } });
      await handleRetrieveAgencyPattern(
        { agency: agencyName },
        handlerContext(ctxFor(tenant))
      );
      const after = await prisma.mcpAuditLog.count({ where: { tenantId: tenant.firmId } });
      expect(after - before).toBe(1);

      const latest = await prisma.mcpAuditLog.findFirst({
        where: { tenantId: tenant.firmId },
        orderBy: { ts: "desc" },
      });
      expect(latest!.toolName).toBe("retrieve_agency_pattern");
      expect(latest!.outcome).toBe("ok");
    });
  }
);
