/**
 * `trigger_enrichment` tool handler (GB-107).
 *
 * DB-mediated trigger: sets descriptionEnrichmentStatus = QUEUED on the
 * tenant-scoped opportunity row. The backend GB-107 worker polls QUEUED
 * rows every 60 seconds, fetches the full SAM.gov description, extracts
 * clauses into the compliance matrix, and re-scores. This tool performs
 * no SAM.gov calls itself, so it always returns immediately and the
 * shared daily rate budget is enforced in exactly one place (the worker).
 *
 * Idempotent: COMPLETED rows return COMPLETED without re-queueing;
 * QUEUED/IN_PROGRESS rows report their current state.
 *
 * Tenant-scoped via consultingFirmId from the resolved bearer token —
 * the status write uses updateMany({ id, consultingFirmId }) so a UUID
 * belonging to another tenant can never be queued.
 */
import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { writeAuditEntry, hashInput } from "../lib/audit.js";
import type { ResolvedTokenContext } from "../lib/auth.js";
import {
  triggerEnrichmentInputShape,
  type TriggerEnrichmentInputT,
  type TriggerEnrichmentPayload,
} from "../schemas/trigger-enrichment.js";

const TOOL_NAME = "trigger_enrichment";

const TOOL_DESCRIPTION =
  "Queue on-demand enrichment for an opportunity: the platform fetches the full SAM.gov solicitation " +
  "description (most ingested records hold only a URL pointer), extracts FAR/DFARS clauses, evaluation " +
  "factors, and submission requirements into the compliance matrix, and re-scores the opportunity. " +
  "Returns immediately with a queue status; enrichment normally completes within ~2 minutes. " +
  "Use get_opportunity_detail to see the enriched description and list_compliance_gaps for extracted " +
  "requirements once complete.";

const MAX_RESPONSE_BYTES_HARD = 8 * 1024;

/** Mirrors backend/src/gb107/types.gb107.ts — MCP servers never import backend code. */
const STATUS = {
  QUEUED: "QUEUED",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  NOT_FOUND: "NOT_FOUND",
} as const;

/** Poll cadence is 60s; fetch+extract adds a few seconds. */
const NORMAL_COMPLETION_ESTIMATE_MS = 2 * 60 * 1000;

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

function nextUtcMidnightIso(): string {
  const next = new Date();
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

function buildPayload(
  opportunityId: string,
  row: {
    descriptionEnrichmentStatus: string | null;
    descriptionEnrichedAt: Date | null;
    descriptionEnrichmentError: string | null;
  },
  queuedNow: boolean,
): TriggerEnrichmentPayload {
  const status = row.descriptionEnrichmentStatus;

  if (status === STATUS.COMPLETED) {
    return {
      opportunity_id: opportunityId,
      status: "COMPLETED",
      message: `Already enriched${row.descriptionEnrichedAt ? ` at ${row.descriptionEnrichedAt.toISOString()}` : ""}. get_opportunity_detail now returns the full solicitation text.`,
      estimated_completion: null,
    };
  }
  if (status === STATUS.NOT_FOUND) {
    return {
      opportunity_id: opportunityId,
      status: "FAILED",
      message:
        "SAM.gov reports this notice ID does not exist (it may be archived). Enrichment is not retried for missing notices.",
      estimated_completion: null,
    };
  }
  if (status === STATUS.IN_PROGRESS) {
    return {
      opportunity_id: opportunityId,
      status: "IN_PROGRESS",
      message: "Enrichment is processing right now.",
      estimated_completion: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  const rateLimited =
    !queuedNow &&
    status === STATUS.QUEUED &&
    /rate limited|quota|429|budget/i.test(row.descriptionEnrichmentError ?? "");
  if (rateLimited) {
    return {
      opportunity_id: opportunityId,
      status: "RATE_LIMITED",
      message:
        "Queued, but the shared SAM.gov daily call budget is exhausted. Enrichment resumes automatically after midnight UTC.",
      estimated_completion: nextUtcMidnightIso(),
    };
  }

  return {
    opportunity_id: opportunityId,
    status: "QUEUED",
    message: queuedNow
      ? "Enrichment queued. The worker picks it up within ~60 seconds."
      : "Already queued for enrichment.",
    estimated_completion: new Date(Date.now() + NORMAL_COMPLETION_ESTIMATE_MS).toISOString(),
  };
}

export async function handleTriggerEnrichment(
  input: TriggerEnrichmentInputT,
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

    const opp = await prisma.opportunity.findFirst({
      where: { id: input.opportunity_id, consultingFirmId: tenantId },
      select: {
        id: true,
        samNoticeId: true,
        descriptionEnrichmentStatus: true,
        descriptionEnrichedAt: true,
        descriptionEnrichmentError: true,
      },
    });

    if (!opp) {
      throw new Error("Opportunity not found for this tenant");
    }
    if (!opp.samNoticeId) {
      const payload: TriggerEnrichmentPayload = {
        opportunity_id: input.opportunity_id,
        status: "FAILED",
        message:
          "This opportunity has no SAM.gov notice ID (manually created or non-SAM source) — there is nothing to fetch.",
        estimated_completion: null,
      };
      return await respond(payload, opts, { correlationId, startedAt, inputHash });
    }

    let queuedNow = false;
    const current = opp.descriptionEnrichmentStatus;
    if (current === null || current === STATUS.FAILED) {
      // Tenant-scoped write — the only business-table mutation this server
      // performs, and the designed GB-107 trigger mechanism. The status
      // guard makes the write idempotent under concurrent calls.
      const updated = await prisma.opportunity.updateMany({
        where: {
          id: input.opportunity_id,
          consultingFirmId: tenantId,
          OR: [
            { descriptionEnrichmentStatus: null },
            { descriptionEnrichmentStatus: STATUS.FAILED },
          ],
        },
        data: { descriptionEnrichmentStatus: STATUS.QUEUED, descriptionEnrichmentError: null },
      });
      queuedNow = updated.count > 0;
    }

    const payload = buildPayload(
      input.opportunity_id,
      {
        descriptionEnrichmentStatus: queuedNow ? STATUS.QUEUED : current,
        descriptionEnrichedAt: opp.descriptionEnrichedAt,
        descriptionEnrichmentError: opp.descriptionEnrichmentError,
      },
      queuedNow,
    );

    return await respond(payload, opts, { correlationId, startedAt, inputHash });
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

async function respond(
  payload: TriggerEnrichmentPayload,
  opts: HandlerContext,
  meta: { correlationId: string; startedAt: number; inputHash: string },
): Promise<HandlerResult> {
  const text = JSON.stringify(payload, null, 2);
  const outputBytes = Buffer.byteLength(text, "utf8");
  if (outputBytes > MAX_RESPONSE_BYTES_HARD) {
    throw new Error(`response of ${outputBytes} bytes exceeds hard cap ${MAX_RESPONSE_BYTES_HARD}`);
  }

  const durationMs = Date.now() - meta.startedAt;
  await writeAuditEntry({
    serverName: opts.serverName,
    serverVersion: opts.serverVersion,
    toolName: TOOL_NAME,
    tenantId: opts.ctx.consultingFirmId,
    tokenFp: opts.ctx.tokenFp,
    inputHash: meta.inputHash,
    outputBytes,
    durationMs,
    outcome: "ok",
    correlationId: meta.correlationId,
  });

  logger.info("tool ok", {
    correlation_id: meta.correlationId,
    tenant_id: opts.ctx.consultingFirmId,
    tool_name: TOOL_NAME,
    latency_ms: durationMs,
    status: payload.status,
  });

  return { content: [{ type: "text", text }] };
}

export function registerTriggerEnrichment(server: McpServer, opts: HandlerContext): void {
  server.tool(
    TOOL_NAME,
    TOOL_DESCRIPTION,
    triggerEnrichmentInputShape,
    async (input: TriggerEnrichmentInputT) => handleTriggerEnrichment(input, opts),
  );
}
