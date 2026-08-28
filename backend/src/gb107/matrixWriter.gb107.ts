// =============================================================
// GB-107 compliance matrix writer.
//
// Writes extracted requirements into the EXISTING ComplianceMatrix /
// MatrixRequirement tables (same tables the AI requirement-extraction
// worker uses), marked with extractionMethod GB107_REGEX so re-runs
// replace only this module's rows and never touch AI- or manually-
// entered requirements. Clause titles resolve from the FarClause /
// DfarsClause catalog when present.
// =============================================================
import type { PrismaClient } from '@prisma/client'
import { lookup } from '../services/far/farCatalogService'
import { GB107_EXTRACTION_METHOD, type ExtractedRequirement } from './types.gb107'

const SECTION_TYPE_BY_REQUIREMENT: Record<ExtractedRequirement['requirementType'], string> = {
  FAR_CLAUSE: 'CLAUSE',
  DFARS_CLAUSE: 'CLAUSE',
  EVAL_FACTOR: 'EVALUATION',
  SUBMISSION_REQ: 'INSTRUCTION',
  DELIVERY_REQ: 'PERFORMANCE',
}

const EXTRACTION_CONFIDENCE = 0.7

async function resolveClauseLabel(req: ExtractedRequirement): Promise<string> {
  if (!req.reference) return req.description
  const source = req.requirementType === 'DFARS_CLAUSE' ? 'DFARS' : 'FAR'
  const record = await lookup(req.reference, source).catch(() => null)
  return record?.title ? `${req.reference} — ${record.title}` : req.description
}

export async function writeRequirementsToMatrix(
  prisma: PrismaClient,
  args: {
    opportunityId: string
    consultingFirmId: string
    sourceLabel: string
    requirements: ExtractedRequirement[]
  },
): Promise<{ matrixId: string; written: number }> {
  const { opportunityId, consultingFirmId, sourceLabel, requirements } = args

  const matrix =
    (await prisma.complianceMatrix.findUnique({ where: { opportunityId } })) ??
    (await prisma.complianceMatrix.create({
      data: { opportunityId, consultingFirmId, sourceText: sourceLabel },
    }))

  // Idempotent re-run: replace only rows this module wrote.
  await prisma.matrixRequirement.deleteMany({
    where: { matrixId: matrix.id, extractionMethod: GB107_EXTRACTION_METHOD },
  })

  if (requirements.length === 0) {
    return { matrixId: matrix.id, written: 0 }
  }

  const labels = await Promise.all(requirements.map((req) => resolveClauseLabel(req)))

  await prisma.matrixRequirement.createMany({
    data: requirements.map((req, i) => ({
      matrixId: matrix.id,
      section: req.reference ?? req.requirementType,
      sectionType: SECTION_TYPE_BY_REQUIREMENT[req.requirementType],
      requirementText: `${labels[i]}. Context: "${req.extractedText}"`,
      isMandatory: req.isMandatory,
      farReference: req.reference,
      sortOrder: i,
      extractionMethod: GB107_EXTRACTION_METHOD,
      extractionConfidence: EXTRACTION_CONFIDENCE,
    })),
  })

  return { matrixId: matrix.id, written: requirements.length }
}
