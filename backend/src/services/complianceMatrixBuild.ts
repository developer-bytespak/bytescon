// =============================================================
// Builds an opportunity's compliance matrix: reads the solicitation (its
// uploaded documents, else its description, else its basic facts), has the AI
// list the requirements, and replaces the matrix's requirements with them.
// Costs one proposal token and one AI call, like the Generate button.
//
// Used by POST /api/compliance-matrix/:opportunityId/generate and by a
// proposal's own set-up (services/proposalSetup.ts).
// =============================================================
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { checkAiCallLimit, checkProposalTokens, deductProposalTokens } from '../middleware/tierGate'
import { generateComplianceMatrix, extractTextFromDocument } from './complianceMatrixService'
import { restoreUpload } from './fileStorage'

// Postgres text columns reject NUL bytes; PDFs sometimes carry them.
const stripNulls = (s: string) => s.replace(/\x00/g, '')

export type MatrixBuildResult =
  | { ok: true; matrixId: string; requirementCount: number; tokensRemaining: number }
  | { ok: false; reason: 'NOT_FOUND' | 'AI_LIMIT' | 'NO_TOKENS' | 'NO_TEXT'; message: string; current?: number; max?: number; balance?: number }

/** The solicitation text: documents first, then the description, then the basic facts. */
export async function solicitationText(opp: {
  id: string; title: string; agency: string | null; naicsCode: string | null; noticeType?: string | null
  setAsideType: string | null; estimatedValue: unknown; description: string | null
  documents: { id: string; fileName: string; storageKey: string | null }[]
}): Promise<string> {
  let text = ''
  for (const doc of opp.documents) {
    try {
      if (!doc.storageKey || /[/\\]/.test(doc.storageKey) || doc.storageKey.includes('..')) continue
      const filePath = await restoreUpload(doc.storageKey)
      if (!filePath) throw new Error('File missing from storage')
      const txt = await extractTextFromDocument(filePath)
      if (txt.length > 200) text += `\n\n=== ${doc.fileName} ===\n${txt}`
    } catch {
      // File unreadable — skip and continue with other docs
      logger.warn('Could not read document for matrix generation', { docId: doc.id, storageKey: doc.storageKey })
    }
  }
  if (text.length < 200 && opp.description) text = opp.description
  // If still empty, build minimal context from structured fields so the AI
  // can still generate generic compliance requirements for the opportunity.
  if (!text.trim()) {
    text = [
      `Title: ${opp.title}`,
      opp.agency ? `Agency: ${opp.agency}` : '',
      opp.naicsCode ? `NAICS Code: ${opp.naicsCode}` : '',
      opp.noticeType ? `Notice Type: ${opp.noticeType}` : '',
      opp.setAsideType ? `Set-Aside: ${opp.setAsideType}` : '',
      opp.estimatedValue != null ? `Estimated Value: $${Number(opp.estimatedValue).toLocaleString()}` : '',
    ].filter(Boolean).join('\n')
  }
  return text
}

export async function buildComplianceMatrix(consultingFirmId: string, opportunityId: string, userId: string | null): Promise<MatrixBuildResult> {
  const aiCheck = await checkAiCallLimit(consultingFirmId)
  if (!aiCheck.allowed) {
    return { ok: false, reason: 'AI_LIMIT', current: aiCheck.current, max: aiCheck.max, message: `AI call limit reached (${aiCheck.current}/${aiCheck.max} this month). Upgrade your plan for more AI calls.` }
  }
  const tokenCheck = await checkProposalTokens(consultingFirmId, 1)
  if (!tokenCheck.allowed) {
    return { ok: false, reason: 'NO_TOKENS', balance: tokenCheck.balance, message: 'You have no proposal tokens remaining. Purchase more in Billing → Proposal Token Packs.' }
  }

  const opp = await prisma.opportunity.findFirst({
    where: { id: opportunityId, consultingFirmId },
    // Include all uploaded docs — not just AI-analyzed ones — so the matrix
    // can be generated even if document analysis was never run.
    include: { documents: { orderBy: { uploadedAt: 'desc' }, take: 5 } },
  })
  if (!opp) return { ok: false, reason: 'NOT_FOUND', message: 'Opportunity not found' }

  const sourceText = await solicitationText(opp)
  if (!sourceText.trim()) {
    return { ok: false, reason: 'NO_TEXT', message: 'No solicitation text available. Upload the RFP/SOW document or ensure the opportunity has a description.' }
  }

  logger.info('Generating compliance matrix', {
    opportunityId,
    sourceLength: sourceText.length,
    docCount: opp.documents.length,
    usingDescription: opp.documents.length === 0 || sourceText === opp.description,
  })
  const requirements = await generateComplianceMatrix(sourceText, opp.title, opportunityId, consultingFirmId)
  const safeSourceText = stripNulls(sourceText).substring(0, 5000)

  const matrix = await prisma.complianceMatrix.upsert({
    where: { opportunityId },
    update: { sourceText: safeSourceText, generatedAt: new Date() },
    create: { opportunityId, consultingFirmId, sourceText: safeSourceText },
  })
  // Delete old requirements and recreate
  await prisma.matrixRequirement.deleteMany({ where: { matrixId: matrix.id } })
  await prisma.matrixRequirement.createMany({
    data: requirements.map((r) => ({
      matrixId: matrix.id,
      section: stripNulls(r.section),
      sectionType: stripNulls(r.sectionType),
      requirementText: stripNulls(r.requirementText),
      isMandatory: r.isMandatory,
      farReference: r.farReference ? stripNulls(r.farReference) : null,
      sortOrder: r.sortOrder,
    })),
  })

  const tokensRemaining = await deductProposalTokens(consultingFirmId, 1, {
    userId,
    opportunityId,
    reason: 'Compliance matrix generation (1 token)',
  })
  logger.info('Compliance matrix generated', { opportunityId, consultingFirmId, requirementCount: requirements.length })
  return { ok: true, matrixId: matrix.id, requirementCount: requirements.length, tokensRemaining }
}
