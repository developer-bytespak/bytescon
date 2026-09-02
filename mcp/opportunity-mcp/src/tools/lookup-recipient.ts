/**
 * `lookup_recipient` tool handler.
 *
 * Looks up a federal contractor (prime or sub) in the RecipientProfile
 * table by 12-character UEI. This is public SAM.gov / USAspending data
 * — NOT tenant-scoped — but the call is still audit-logged.
 */
import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { writeAuditEntry, hashInput } from "../lib/audit.js";
import type { ResolvedTokenContext } from "../lib/auth.js";
import { sanitize } from "./search-opportunities.js";
import {
  lookupRecipientInputShape,
  type LookupRecipientInputT,
  type RecipientLookupPayload,
} from "../schemas/lookup-recipient.js";

const TOOL_NAME = "lookup_recipient";

const TOOL_DESCRIPTION =
  "Look up a federal contractor by 12-character UEI. Returns legal name, CAGE, " +
  "SAM registration status, NAICS codes, certifications (SDVOSB/WOSB/HUBZone/SB/VA OSDBU), " +
  "and recent award count from USAspending. Source data is public-domain federal data.";

const MAX_RESPONSE_BYTES_HARD = 12 * 1024;

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

export async function handleLookupRecipient(
  input: LookupRecipientInputT,
  opts: HandlerContext,
): Promise<HandlerResult> {
  const correlationId = crypto.randomUUID();
  const startedAt = Date.now();
  const inputHash = hashInput(input);

  try {
    const uei = input.uei.toUpperCase();
    const profile = await prisma.recipientProfile.findUnique({
      where: { uei },
      select: {
        uei: true,
        legalName: true,
        cageCode: true,
        samRegStatus: true,
        samRegExpiry: true,
        website: true,
        naicsCodes: true,
        sdvosb: true,
        wosb: true,
        hubzone: true,
        smallBusiness: true,
        vaOsdbuVerified: true,
      },
    });

    if (!profile) {
      throw new Error(`no recipient profile for UEI ${uei}`);
    }

    const naicsArray: string[] = Array.isArray(profile.naicsCodes)
      ? (profile.naicsCodes as unknown[]).filter((x): x is string => typeof x === "string")
      : [];

    const recentAwardCount = profile.legalName
      ? await prisma.opportunity
          .count({ where: { historicalWinner: profile.legalName } })
          .catch(() => 0)
      : 0;

    const payload: RecipientLookupPayload = {
      uei: profile.uei,
      legal_name: profile.legalName ? sanitize(profile.legalName) : null,
      cage_code: profile.cageCode,
      sam_reg_status: profile.samRegStatus,
      sam_reg_expiry: profile.samRegExpiry ? profile.samRegExpiry.toISOString() : null,
      website: profile.website,
      naics_codes: naicsArray,
      certifications: {
        sdvosb: profile.sdvosb,
        wosb: profile.wosb,
        hubzone: profile.hubzone,
        small_business: profile.smallBusiness,
        va_osdbu_verified: profile.vaOsdbuVerified,
      },
      recent_award_count: recentAwardCount,
    };

    const text = JSON.stringify(payload, null, 2);
    const outputBytes = Buffer.byteLength(text, "utf8");
    if (outputBytes > MAX_RESPONSE_BYTES_HARD) {
      throw new Error(`response of ${outputBytes} bytes exceeds hard cap ${MAX_RESPONSE_BYTES_HARD}`);
    }

    const durationMs = Date.now() - startedAt;
    await writeAuditEntry({
      serverName: opts.serverName,
      serverVersion: opts.serverVersion,
      toolName: TOOL_NAME,
      tenantId: opts.ctx.consultingFirmId,
      tokenFp: opts.ctx.tokenFp,
      inputHash,
      outputBytes,
      durationMs,
      outcome: "ok",
      correlationId,
    });

    logger.info("tool ok", {
      correlation_id: correlationId,
      tenant_id: opts.ctx.consultingFirmId,
      tool_name: TOOL_NAME,
      latency_ms: durationMs,
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

export function registerLookupRecipient(server: McpServer, opts: HandlerContext): void {
  server.tool(
    TOOL_NAME,
    TOOL_DESCRIPTION,
    lookupRecipientInputShape,
    async (input: LookupRecipientInputT) => handleLookupRecipient(input, opts),
  );
}
