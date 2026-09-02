/**
 * `list_compliance_gaps` tool handler.
 *
 * Returns outstanding (non-COMPLETED) MatrixRequirement rows for the
 * given opportunity, scoped to the caller's tenant via the parent
 * ComplianceMatrix. Mandatory items sort first.
 */
import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { writeAuditEntry, hashInput } from "../lib/audit.js";
import type { ResolvedTokenContext } from "../lib/auth.js";
import { sanitize } from "./search-opportunities.js";
import {
  listComplianceGapsInputShape,
  type ListComplianceGapsInputT,
  type ListComplianceGapsPayload,
  type ComplianceGapRow,
} from "../schemas/list-compliance-gaps.js";

const TOOL_NAME = "list_compliance_gaps";

const TOOL_DESCRIPTION =
  "List unfulfilled compliance-matrix requirements for an opportunity (outstanding " +
  "FAR/DFARS clauses, instructions, evaluation criteria). Mandatory items are returned " +
  "first; set mandatory_only=true to filter to required items only.";

const MAX_RESPONSE_BYTES_HARD = 32 * 1024;
const MAX_GAPS = 100;

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

export async function handleListComplianceGaps(
  input: ListComplianceGapsInputT,
  opts: HandlerContext,
): Promise<HandlerResult> {
  const correlationId = crypto.randomUUID();
  const startedAt = Date.now();
  const inputHash = hashInput(input);

  try {
    const matrix = await prisma.complianceMatrix.findFirst({
      where: {
        consultingFirmId: opts.ctx.consultingFirmId,
        opportunityId: input.opportunity_id,
      },
      select: { id: true },
    });

    if (!matrix) {
      const payload: ListComplianceGapsPayload = {
        opportunity_id: input.opportunity_id,
        has_matrix: false,
        count: 0,
        mandatory_open: 0,
        gaps: [],
      };
      const text = JSON.stringify(payload, null, 2);
      const durationMs = Date.now() - startedAt;
      await writeAuditEntry({
        serverName: opts.serverName,
        serverVersion: opts.serverVersion,
        toolName: TOOL_NAME,
        tenantId: opts.ctx.consultingFirmId,
        tokenFp: opts.ctx.tokenFp,
        inputHash,
        outputBytes: Buffer.byteLength(text, "utf8"),
        durationMs,
        outcome: "ok",
        correlationId,
      });
      return { content: [{ type: "text", text }] };
    }

    const where: Record<string, unknown> = {
      matrixId: matrix.id,
      NOT: { status: "COMPLETED" },
    };
    if (input.mandatory_only) where["isMandatory"] = true;

    const rows = await prisma.matrixRequirement.findMany({
      where,
      take: MAX_GAPS,
      orderBy: [{ isMandatory: "desc" }, { sortOrder: "asc" }],
      select: {
        id: true,
        section: true,
        sectionType: true,
        farReference: true,
        isMandatory: true,
        status: true,
        requirementText: true,
        proposalSection: true,
      },
    });

    const gaps: ComplianceGapRow[] = rows.map((r: (typeof rows)[number]) => ({
      id: r.id,
      section: sanitize(r.section),
      section_type: r.sectionType,
      far_reference: r.farReference,
      is_mandatory: r.isMandatory,
      status: r.status,
      requirement_text: sanitize(r.requirementText),
      proposal_section: r.proposalSection,
    }));

    const mandatoryOpen = gaps.filter((g) => g.is_mandatory).length;

    const payload: ListComplianceGapsPayload = {
      opportunity_id: input.opportunity_id,
      has_matrix: true,
      count: gaps.length,
      mandatory_open: mandatoryOpen,
      gaps,
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
      result_count: gaps.length,
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

export function registerListComplianceGaps(server: McpServer, opts: HandlerContext): void {
  server.tool(
    TOOL_NAME,
    TOOL_DESCRIPTION,
    listComplianceGapsInputShape,
    async (input: ListComplianceGapsInputT) => handleListComplianceGaps(input, opts),
  );
}
