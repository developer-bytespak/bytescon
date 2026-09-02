/**
 * `list_agencies_by_naics` tool handler.
 *
 * Aggregates the calling tenant's opportunities for one 6-digit NAICS
 * code by agency: total count (any status, so the tenant's full
 * history informs the ranking), open count (ACTIVE), average
 * estimated value, and set-aside mix. Joins the GLOBAL
 * agency_award_profiles table for small-business and SDVOSB award
 * rates where a profile exists. The join is global reference data
 * (rates only), so no tenant data crosses the boundary.
 *
 * Tenant-scoped via consultingFirmId from the resolved bearer token.
 */
import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { writeAuditEntry, hashInput } from "../lib/audit.js";
import type { ResolvedTokenContext } from "../lib/auth.js";
import { sanitize } from "./search-opportunities.js";
import {
  listAgenciesByNaicsInputShape,
  type ListAgenciesByNaicsInputT,
  type ListAgenciesByNaicsPayload,
  type AgencyNaicsRow,
} from "../schemas/list-agencies-by-naics.js";

const TOOL_NAME = "list_agencies_by_naics";

const TOOL_DESCRIPTION =
  "Which agencies buy a given NAICS code, ranked by the calling tenant's opportunity count. " +
  "For each agency: total and open opportunity counts, average estimated value, set-aside mix, " +
  "and (when available) the agency's global small-business and SDVOSB award rates from its award profile. " +
  "Use this to target agencies before searching or forecasting.";

const MAX_RESPONSE_BYTES_HARD = 16 * 1024;

interface HandlerContext {
  ctx: ResolvedTokenContext;
  serverName: string;
  serverVersion: string;
}

interface HandlerResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface DecimalLike {
  toNumber: () => number;
}

interface OppRow {
  agency: string;
  status: string;
  estimatedValue: DecimalLike | null;
  setAsideType: string;
}

interface ProfileRow {
  agencyName: string;
  avgAwardValue: number | null;
  smallBizRate: number;
  sdvosbRate: number;
}

export async function handleListAgenciesByNaics(
  input: ListAgenciesByNaicsInputT,
  opts: HandlerContext,
): Promise<HandlerResult> {
  const correlationId = crypto.randomUUID();
  const startedAt = Date.now();
  const inputHash = hashInput(input);

  logger.info("tool invoked", {
    correlation_id: correlationId,
    tenant_id: opts.ctx.consultingFirmId,
    tool_name: TOOL_NAME,
    token_fp: opts.ctx.tokenFp,
  });

  try {
    const tenantId = opts.ctx.consultingFirmId;

    const opps = (await prisma.opportunity.findMany({
      where: {
        consultingFirmId: tenantId,
        naicsCode: input.naics,
      },
      select: {
        agency: true,
        status: true,
        estimatedValue: true,
        setAsideType: true,
      },
    })) as unknown as OppRow[];

    const byAgency = new Map<string, OppRow[]>();
    for (const o of opps) {
      const list = byAgency.get(o.agency);
      if (list) list.push(o);
      else byAgency.set(o.agency, [o]);
    }

    const ranked = [...byAgency.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, input.top_n);

    // Join global award profiles for the agencies on the page (rates only).
    const agencyNames = ranked.map(([agency]) => agency);
    const profiles =
      agencyNames.length > 0
        ? ((await prisma.agencyAwardProfile.findMany({
            where: { agencyName: { in: agencyNames } },
            select: {
              agencyName: true,
              avgAwardValue: true,
              smallBizRate: true,
              sdvosbRate: true,
            },
          })) as ProfileRow[])
        : [];
    const profileByName = new Map<string, ProfileRow>();
    for (const p of profiles) profileByName.set(p.agencyName, p);

    const results: AgencyNaicsRow[] = ranked.map(([agency, group]) => {
      const values: number[] = [];
      const mix = new Map<string, number>();
      let openCount = 0;
      for (const r of group) {
        if (r.estimatedValue) values.push(r.estimatedValue.toNumber());
        if (r.status === "ACTIVE") openCount += 1;
        mix.set(r.setAsideType, (mix.get(r.setAsideType) ?? 0) + 1);
      }
      const avgVal = values.length
        ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2))
        : null;
      const profile = profileByName.get(agency);
      return {
        agency: sanitize(agency),
        opportunity_count: group.length,
        open_count: openCount,
        avg_estimated_value: avgVal,
        set_aside_mix: [...mix.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([setAside, count]) => ({ set_aside: sanitize(setAside), count })),
        award_profile: profile
          ? {
              avg_award_value: profile.avgAwardValue,
              small_biz_rate: profile.smallBizRate,
              sdvosb_rate: profile.sdvosbRate,
            }
          : null,
      };
    });

    const payload: ListAgenciesByNaicsPayload = {
      naics: input.naics,
      count: results.length,
      results,
      generated_at: new Date().toISOString(),
    };

    const text = JSON.stringify(payload, null, 2);
    const outputBytes = Buffer.byteLength(text, "utf8");
    if (outputBytes > MAX_RESPONSE_BYTES_HARD) {
      throw new Error(
        `response of ${outputBytes} bytes exceeds hard cap ${MAX_RESPONSE_BYTES_HARD}; lower top_n`,
      );
    }

    const durationMs = Date.now() - startedAt;
    await writeAuditEntry({
      serverName: opts.serverName,
      serverVersion: opts.serverVersion,
      toolName: TOOL_NAME,
      tenantId,
      tokenFp: opts.ctx.tokenFp,
      inputHash,
      outputBytes,
      durationMs,
      outcome: "ok",
      correlationId,
    });

    logger.info("tool ok", {
      correlation_id: correlationId,
      tenant_id: tenantId,
      tool_name: TOOL_NAME,
      latency_ms: durationMs,
      naics: input.naics,
      agencies_returned: results.length,
    });

    return { content: [{ type: "text", text }] };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    logger.error("tool error", {
      correlation_id: correlationId,
      tenant_id: opts.ctx.consultingFirmId,
      tool_name: TOOL_NAME,
      err: message,
    });
    await writeAuditEntry({
      serverName: opts.serverName,
      serverVersion: opts.serverVersion,
      toolName: TOOL_NAME,
      tenantId: opts.ctx.consultingFirmId,
      tokenFp: opts.ctx.tokenFp,
      inputHash,
      outputBytes: 0,
      durationMs,
      outcome: "tool_error",
      correlationId,
    }).catch(() => undefined);
    return { isError: true, content: [{ type: "text", text: `Tool error: ${message}` }] };
  }
}

export function registerListAgenciesByNaics(server: McpServer, opts: HandlerContext): void {
  server.tool(
    TOOL_NAME,
    TOOL_DESCRIPTION,
    listAgenciesByNaicsInputShape,
    async (input: ListAgenciesByNaicsInputT) => handleListAgenciesByNaics(input, opts),
  );
}
