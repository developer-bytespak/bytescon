// =============================================================
// FAR Applicability Writer — persists per-opportunity applicability
// rows derived from the same FAR context that grounds LLM inference.
//
// The FarClauseApplicability table is the queryable source of truth
// for "which FAR / DFARS / CMMC / 508 obligations apply to this opp".
// Without it, FAR coverage is only retrievable from AuditEvent.farClausesReferenced
// (per-LLM-call) or from rebuilding the context on demand. This writer
// gives the UI and reporting layer a stable, indexed table.
//
// Idempotent: deletes existing AI_EXTRACTED + INFERRED rows for the
// opportunity before inserting fresh ones. MANUAL + RFP_EXPLICIT rows
// (operator overrides, explicit RFP cites) are preserved.
// =============================================================
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import { buildContext, FarContext } from './farContextBuilder'

export interface ApplicabilityWriteResult {
  written: number
  far: number
  dfars: number
  cmmc: number
  section508: number
  contextHash: string
}

/**
 * Compute and persist FarClauseApplicability rows for an opportunity.
 * Pass a pre-built FarContext to avoid a duplicate buildContext call —
 * useful when the caller (requirementExtractionWorker) already has one.
 */
export async function writeFarApplicabilities(
  opportunityId: string,
  consultingFirmId: string,
  preBuiltContext?: FarContext,
): Promise<ApplicabilityWriteResult> {
  const ctx = preBuiltContext ?? (await buildContext(opportunityId, 'REQUIREMENT_EXTRACTION'))

  const rows: Array<{
    consultingFirmId: string
    opportunityId: string
    clauseSource: string
    clauseCode: string
    applicabilitySource: string
    confidence: number
    isBlocking: boolean
    isFlowDown: boolean
    notes: string | null
  }> = []

  for (const c of ctx.applicableFarClauses) {
    rows.push({
      consultingFirmId,
      opportunityId,
      clauseSource: 'FAR',
      clauseCode: c.code,
      applicabilitySource: 'INFERRED',
      confidence: 0.85,
      isBlocking: c.isBlocking,
      isFlowDown: c.flowDownRequired,
      notes: c.title,
    })
  }
  for (const c of ctx.applicableDfarsClauses) {
    rows.push({
      consultingFirmId,
      opportunityId,
      clauseSource: 'DFARS',
      clauseCode: c.code,
      applicabilitySource: 'INFERRED',
      confidence: 0.85,
      isBlocking: c.isBlocking,
      isFlowDown: c.flowDownRequired,
      notes: c.title,
    })
  }
  if (ctx.cmmcLevel) {
    rows.push({
      consultingFirmId,
      opportunityId,
      clauseSource: 'CMMC',
      clauseCode: `LEVEL_${ctx.cmmcLevel}`,
      applicabilitySource: 'INFERRED',
      confidence: 0.85,
      isBlocking: true,
      isFlowDown: true,
      notes: `CMMC Level ${ctx.cmmcLevel} required for this opportunity profile`,
    })
  }
  if (ctx.section508Required) {
    rows.push({
      consultingFirmId,
      opportunityId,
      clauseSource: '508',
      clauseCode: 'COMPLIANCE_REQUIRED',
      applicabilitySource: 'INFERRED',
      confidence: 0.9,
      isBlocking: false,
      isFlowDown: true,
      notes: 'Section 508 accessibility required (federal civilian buy)',
    })
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.farClauseApplicability.deleteMany({
      where: {
        opportunityId,
        consultingFirmId,
        applicabilitySource: { in: ['AI_EXTRACTED', 'INFERRED'] },
      },
    })
    if (rows.length === 0) return { count: 0 }
    return tx.farClauseApplicability.createMany({ data: rows })
  })

  const counts = {
    far: rows.filter((r) => r.clauseSource === 'FAR').length,
    dfars: rows.filter((r) => r.clauseSource === 'DFARS').length,
    cmmc: rows.filter((r) => r.clauseSource === 'CMMC').length,
    section508: rows.filter((r) => r.clauseSource === '508').length,
  }

  logger.info('FAR applicability rows written', {
    opportunityId,
    consultingFirmId,
    written: result.count,
    contextHash: ctx.hash,
    ...counts,
  })

  return { written: result.count, contextHash: ctx.hash, ...counts }
}
