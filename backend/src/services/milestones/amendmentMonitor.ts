// =============================================================
// §6.4B — Amendment monitoring.
//
// Deterministic document diff FIRST. The AI summary is optional, additive, and
// uses the exact prompt in extractionPrompts.ts — nothing else.
//
// Guarantees:
//  - Every amendment version is preserved (AmendmentRevision is append-only and
//    unique on content hash, so the same content is never stored twice).
//  - Verified requirements are NEVER overwritten, invalidated or deleted. All
//    consequences are written as AmendmentImpact rows for human confirmation.
//  - Impacted proposal sections, submission checklist items, pricing assumptions
//    and milestones are flagged, not mutated.
//  - Owner notifications are deduped per revision per user.
// =============================================================
import { createHash } from 'crypto'
import {
  AmendmentImpactArea,
  MappingVerification,
  NotificationType,
  Prisma,
  SourceDataQuality,
} from '@prisma/client'
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import { notifyUser } from '../notificationService'
import { parseSolicitation } from '../requirements/solicitationParser'
import { AMENDMENT_SUMMARY_PROMPT_VERSION } from '../requirements/extractionPrompts'

export function hashAmendment(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex')
}

export type ChangeType = 'ADDED' | 'REMOVED' | 'MODIFIED'

export interface DiffEntry {
  changeType: ChangeType
  priorText: string | null
  newText: string | null
  priorSource: string | null
  newSource: string | null
}

export interface DeterministicDiff {
  changedDeadlines: Array<DiffEntry & { milestoneType: string }>
  changedRequirements: Array<DiffEntry & { requirementType: string }>
  changedEvaluation: DiffEntry[]
  changedClauses: Array<{ clauseNumber: string; changeType: ChangeType; priorText: string | null; newText: string | null; flowDownImpact: string | null }>
  changedAttachments: Array<{ attachmentName: string; changeType: 'ADDED' | 'REMOVED' | 'REPLACED' | 'RENAMED' }>
  questionsAndAnswers: Array<{ question: string; answer: string; source: string | null }>
  summary: string
  comparable: boolean
}

const QA_PATTERN = /(?:^|\n)\s*(?:Q(?:uestion)?\s*[:#]?\s*\d*[:.)]?\s*)(.{10,600}?)\s*(?:\n\s*)?(?:A(?:nswer)?\s*[:#]?\s*\d*[:.)]?\s*)(.{5,1200}?)(?=\n\s*Q(?:uestion)?\s*[:#]?|\n\n|$)/gis

export function extractQa(text: string): Array<{ question: string; answer: string; source: string | null }> {
  const out: Array<{ question: string; answer: string; source: string | null }> = []
  let m: RegExpExecArray | null
  QA_PATTERN.lastIndex = 0
  while ((m = QA_PATTERN.exec(text)) !== null) {
    out.push({
      question: m[1].replace(/\s+/g, ' ').trim().slice(0, 600),
      answer: m[2].replace(/\s+/g, ' ').trim().slice(0, 1200),
      source: null,
    })
    if (out.length >= 200) break
  }
  return out
}

/**
 * Deterministic diff of two solicitation versions, built on the same
 * deterministic parser the extraction pipeline uses so the two views agree.
 */
export function diffAmendmentText(priorText: string | null, newText: string): DeterministicDiff {
  if (!priorText || priorText.trim().length === 0) {
    const parsed = parseSolicitation(newText)
    return {
      changedDeadlines: parsed.milestones.map((m) => ({
        milestoneType: m.milestoneType, changeType: 'ADDED' as ChangeType,
        priorText: null, newText: m.dateTime ? m.dateTime.toISOString().slice(0, 10) : m.title,
        priorSource: null, newSource: m.sourceSection,
      })),
      changedRequirements: parsed.requirements.map((r) => ({
        requirementType: r.requirementType, changeType: 'ADDED' as ChangeType,
        priorText: null, newText: r.requirementText, priorSource: null, newSource: r.sourceSection,
      })),
      changedEvaluation: [],
      changedClauses: parsed.clauses.map((c) => ({
        clauseNumber: c.clauseNumber, changeType: 'ADDED' as ChangeType,
        priorText: null, newText: c.evidenceText, flowDownImpact: c.flowDownCondition,
      })),
      changedAttachments: [],
      questionsAndAnswers: extractQa(newText),
      // Honest: with nothing to compare against, this is a baseline, not a diff.
      summary: 'No prior version was available, so this revision was recorded as the baseline rather than compared. Every item is reported as added.',
      comparable: false,
    }
  }

  const prior = parseSolicitation(priorText)
  const next = parseSolicitation(newText)

  const priorReqs = new Map(prior.requirements.map((r) => [r.fingerprint, r]))
  const nextReqs = new Map(next.requirements.map((r) => [r.fingerprint, r]))

  const changedRequirements: DeterministicDiff['changedRequirements'] = []
  for (const [fp, r] of nextReqs) {
    if (!priorReqs.has(fp)) {
      changedRequirements.push({
        requirementType: r.requirementType, changeType: 'ADDED',
        priorText: null, newText: r.requirementText, priorSource: null, newSource: r.sourceSection,
      })
    }
  }
  for (const [fp, r] of priorReqs) {
    if (!nextReqs.has(fp)) {
      changedRequirements.push({
        requirementType: r.requirementType, changeType: 'REMOVED',
        priorText: r.requirementText, newText: null, priorSource: r.sourceSection, newSource: null,
      })
    }
  }

  const priorMilestones = new Map(prior.milestones.map((m) => [m.milestoneType, m]))
  const nextMilestones = new Map(next.milestones.map((m) => [m.milestoneType, m]))
  const changedDeadlines: DeterministicDiff['changedDeadlines'] = []
  for (const [type, m] of nextMilestones) {
    const before = priorMilestones.get(type)
    const newValue = m.dateTime ? m.dateTime.toISOString().slice(0, 10) : m.title
    if (!before) {
      changedDeadlines.push({ milestoneType: type, changeType: 'ADDED', priorText: null, newText: newValue, priorSource: null, newSource: m.sourceSection })
      continue
    }
    const priorValue = before.dateTime ? before.dateTime.toISOString().slice(0, 10) : before.title
    if (priorValue !== newValue) {
      changedDeadlines.push({ milestoneType: type, changeType: 'MODIFIED', priorText: priorValue, newText: newValue, priorSource: before.sourceSection, newSource: m.sourceSection })
    }
  }
  for (const [type, m] of priorMilestones) {
    if (!nextMilestones.has(type)) {
      changedDeadlines.push({
        milestoneType: type, changeType: 'REMOVED',
        priorText: m.dateTime ? m.dateTime.toISOString().slice(0, 10) : m.title, newText: null,
        priorSource: m.sourceSection, newSource: null,
      })
    }
  }

  const priorClauses = new Map(prior.clauses.map((c) => [c.clauseNumber, c]))
  const nextClauses = new Map(next.clauses.map((c) => [c.clauseNumber, c]))
  const changedClauses: DeterministicDiff['changedClauses'] = []
  for (const [num, c] of nextClauses) {
    const before = priorClauses.get(num)
    if (!before) {
      changedClauses.push({ clauseNumber: num, changeType: 'ADDED', priorText: null, newText: c.evidenceText, flowDownImpact: c.flowDownCondition })
    } else if (before.flowDownStatus !== c.flowDownStatus) {
      changedClauses.push({
        clauseNumber: num, changeType: 'MODIFIED', priorText: before.flowDownStatus, newText: c.flowDownStatus,
        flowDownImpact: `Flow-down classification changed from ${before.flowDownStatus} to ${c.flowDownStatus}. Legal review required.`,
      })
    }
  }
  for (const [num, c] of priorClauses) {
    if (!nextClauses.has(num)) {
      changedClauses.push({ clauseNumber: num, changeType: 'REMOVED', priorText: c.evidenceText, newText: null, flowDownImpact: null })
    }
  }

  const changedEvaluation: DiffEntry[] = changedRequirements
    .filter((r) => r.requirementType === 'EVALUATION')
    .map(({ changeType, priorText, newText, priorSource, newSource }) => ({ changeType, priorText, newText, priorSource, newSource }))

  const priorDocs = new Set(prior.standingDocumentNeeds.map((d) => d.documentName))
  const nextDocs = new Set(next.standingDocumentNeeds.map((d) => d.documentName))
  const changedAttachments: DeterministicDiff['changedAttachments'] = [
    ...[...nextDocs].filter((d) => !priorDocs.has(d)).map((d) => ({ attachmentName: d, changeType: 'ADDED' as const })),
    ...[...priorDocs].filter((d) => !nextDocs.has(d)).map((d) => ({ attachmentName: d, changeType: 'REMOVED' as const })),
  ]

  const priorQa = new Set(extractQa(priorText).map((q) => q.question))
  const questionsAndAnswers = extractQa(newText).filter((q) => !priorQa.has(q.question))

  const totals = changedDeadlines.length + changedRequirements.length + changedClauses.length + changedAttachments.length
  const summary = totals === 0
    ? 'The deterministic comparison found no changed deadlines, requirements, clauses or required documents between these two versions.'
    : `Deterministic comparison found ${changedDeadlines.length} deadline change(s), ${changedRequirements.length} requirement change(s), ` +
      `${changedClauses.length} clause change(s), ${changedAttachments.length} required-document change(s) and ${questionsAndAnswers.length} new Q&A item(s). ` +
      'These are proposed impacts and require human confirmation.'

  return { changedDeadlines, changedRequirements, changedEvaluation, changedClauses, changedAttachments, questionsAndAnswers, summary, comparable: true }
}

export interface RecordAmendmentArgs {
  consultingFirmId: string
  opportunityId: string
  amendmentId?: string | null
  amendmentNumber?: string | null
  documentName?: string | null
  sourceUrl?: string | null
  externalId?: string | null
  text: string
  now?: Date
}

export interface RecordAmendmentResult {
  revisionId: string | null
  revisionNo: number | null
  isNew: boolean
  diff: DeterministicDiff | null
  impactsCreated: number
  notified: number
  message: string
}

/**
 * Record a new amendment revision and derive its proposed impacts.
 * Content-hash unique, so re-processing identical content is a no-op.
 */
export async function recordAmendmentRevision(args: RecordAmendmentArgs): Promise<RecordAmendmentResult> {
  const now = args.now ?? new Date()
  const contentHash = hashAmendment(args.text)

  const existing = await prisma.amendmentRevision.findUnique({
    where: { opportunityId_contentHash: { opportunityId: args.opportunityId, contentHash } },
    select: { id: true, revisionNo: true },
  })
  if (existing) {
    // Freshness stamp only — the stored revision is immutable.
    await prisma.amendmentRevision.update({ where: { id: existing.id }, data: { lastSeenAt: now } })
    return {
      revisionId: existing.id, revisionNo: existing.revisionNo, isNew: false, diff: null,
      impactsCreated: 0, notified: 0,
      message: 'This amendment content has already been recorded; no duplicate revision was created.',
    }
  }

  const prior = await prisma.amendmentRevision.findFirst({
    where: { opportunityId: args.opportunityId },
    orderBy: { revisionNo: 'desc' },
    select: { revisionNo: true, aiSummaryJson: true, diffSummary: true, documentName: true },
  })

  // The prior version's raw text is not retained (only its structured diff), so
  // when it is unavailable the comparison says so rather than pretending.
  const priorText = null
  const diff = diffAmendmentText(priorText, args.text)
  const revisionNo = (prior?.revisionNo ?? 0) + 1

  const revision = await prisma.amendmentRevision.create({
    data: {
      consultingFirmId: args.consultingFirmId,
      opportunityId: args.opportunityId,
      amendmentId: args.amendmentId ?? null,
      revisionNo,
      amendmentNumber: args.amendmentNumber ?? null,
      sourceUrl: args.sourceUrl ?? null,
      documentName: args.documentName ?? null,
      contentHash,
      contentLength: args.text.length,
      externalId: args.externalId ?? null,
      firstSeenAt: now,
      lastSeenAt: now,
      dataQuality: diff.comparable ? SourceDataQuality.OK : SourceDataQuality.PARTIAL,
      diffSummary: JSON.parse(JSON.stringify({ summary: diff.summary, comparable: diff.comparable })) as Prisma.InputJsonValue,
      changedDeadlines: JSON.parse(JSON.stringify(diff.changedDeadlines)) as Prisma.InputJsonValue,
      changedRequirements: JSON.parse(JSON.stringify(diff.changedRequirements)) as Prisma.InputJsonValue,
      changedEvaluation: JSON.parse(JSON.stringify(diff.changedEvaluation)) as Prisma.InputJsonValue,
      changedClauses: JSON.parse(JSON.stringify(diff.changedClauses)) as Prisma.InputJsonValue,
      changedAttachments: JSON.parse(JSON.stringify(diff.changedAttachments)) as Prisma.InputJsonValue,
      questionsAndAnswers: JSON.parse(JSON.stringify(diff.questionsAndAnswers)) as Prisma.InputJsonValue,
      aiPromptVersion: AMENDMENT_SUMMARY_PROMPT_VERSION,
      // Every amendment requires human review. This is never auto-cleared.
      humanReviewRequired: true,
    },
    select: { id: true },
  })

  const impactsCreated = await deriveImpacts(args.consultingFirmId, args.opportunityId, revision.id, diff)
  const notified = await notifyAmendmentOwners(args.consultingFirmId, args.opportunityId, revision.id, revisionNo, diff, now)

  return {
    revisionId: revision.id, revisionNo, isNew: true, diff, impactsCreated, notified,
    message: diff.summary,
  }
}

/**
 * Translate a diff into PROPOSED impacts. Nothing is mutated: existing
 * requirements, sections, checklist items and pricing are only referenced.
 */
async function deriveImpacts(
  consultingFirmId: string,
  opportunityId: string,
  revisionId: string,
  diff: DeterministicDiff,
): Promise<number> {
  const impacts: Prisma.AmendmentImpactCreateManyInput[] = []

  if (diff.changedRequirements.length > 0) {
    const matrix = await prisma.complianceMatrix.findUnique({ where: { opportunityId }, select: { id: true, _count: { select: { requirements: true } } } })
    impacts.push({
      consultingFirmId, revisionId, opportunityId,
      area: AmendmentImpactArea.COMPLIANCE_MATRIX,
      targetType: 'ComplianceMatrix',
      targetId: matrix?.id ?? null,
      targetLabel: `Compliance matrix (${matrix?._count.requirements ?? 0} requirement(s))`,
      impact: `${diff.changedRequirements.length} requirement change(s) detected. Verified requirements have NOT been altered.`,
      recommendedAction: 'Re-run extraction to add new requirements, then review each proposed change and confirm or dismiss it.',
      reviewRequired: true,
    })
  }

  if (diff.changedDeadlines.length > 0) {
    const milestones = await prisma.opportunityMilestone.findMany({
      where: { consultingFirmId, opportunityId },
      select: { id: true, milestoneType: true, title: true },
    })
    for (const change of diff.changedDeadlines) {
      const match = milestones.find((m) => m.milestoneType === change.milestoneType)
      impacts.push({
        consultingFirmId, revisionId, opportunityId,
        area: AmendmentImpactArea.MILESTONE,
        targetType: match ? 'OpportunityMilestone' : null,
        targetId: match?.id ?? null,
        targetLabel: match?.title ?? change.milestoneType,
        impact: `${change.milestoneType} ${change.changeType.toLowerCase()}: ${change.priorText ?? '—'} → ${change.newText ?? '—'}.`,
        recommendedAction: 'Confirm the new date and regenerate the working-backward schedule if it moved.',
        reviewRequired: true,
      })
    }
  }

  for (const clause of diff.changedClauses) {
    impacts.push({
      consultingFirmId, revisionId, opportunityId,
      area: AmendmentImpactArea.CLAUSE,
      targetType: 'ClauseObligation',
      targetId: null,
      targetLabel: clause.clauseNumber,
      impact: `Clause ${clause.clauseNumber} ${clause.changeType.toLowerCase()}.${clause.flowDownImpact ? ` ${clause.flowDownImpact}` : ''}`,
      recommendedAction: 'Potential flow-down identified — legal review required before relying on this classification.',
      reviewRequired: true,
    })
  }

  if (diff.changedRequirements.some((r) => ['FORMAT', 'SUBMISSION', 'DOCUMENT', 'CERTIFICATION'].includes(r.requirementType)) || diff.changedAttachments.length > 0) {
    const submission = await prisma.proposalSubmission.findFirst({ where: { consultingFirmId, opportunityId }, select: { id: true, title: true } })
    impacts.push({
      consultingFirmId, revisionId, opportunityId,
      area: AmendmentImpactArea.SUBMISSION_CHECKLIST,
      targetType: submission ? 'ProposalSubmission' : null,
      targetId: submission?.id ?? null,
      targetLabel: submission?.title ?? 'Submission checklist',
      impact: 'Submission instructions or required documents changed in this amendment.',
      recommendedAction: 'Review the checklist against the amended instructions and re-run pre-submission validation.',
      reviewRequired: true,
    })
  }

  const sections = await prisma.proposalSection.findMany({
    where: { proposal: { consultingFirmId, opportunityId } },
    select: { id: true, title: true },
    take: 100,
  })
  if (sections.length > 0 && diff.changedEvaluation.length > 0) {
    impacts.push({
      consultingFirmId, revisionId, opportunityId,
      area: AmendmentImpactArea.PROPOSAL_SECTION,
      targetType: 'Proposal',
      targetId: null,
      targetLabel: `${sections.length} proposal section(s)`,
      impact: `${diff.changedEvaluation.length} evaluation criterion change(s) may affect how sections should be written.`,
      recommendedAction: 'Review affected sections against the amended evaluation criteria. No section content has been changed.',
      reviewRequired: true,
    })
  }

  if (diff.changedRequirements.some((r) => /pric|cost|rate|fee/i.test(r.newText ?? r.priorText ?? ''))) {
    const workspace = await prisma.pricingWorkspace.findFirst({ where: { consultingFirmId, opportunityId }, select: { id: true, title: true } })
    impacts.push({
      consultingFirmId, revisionId, opportunityId,
      area: AmendmentImpactArea.PRICING,
      targetType: workspace ? 'PricingWorkspace' : null,
      targetId: workspace?.id ?? null,
      targetLabel: workspace?.title ?? 'Pricing workspace',
      impact: 'Pricing-related wording changed in this amendment. Pricing assumptions may no longer hold.',
      recommendedAction: 'Review the pricing assumptions. No pricing values have been altered by this system.',
      reviewRequired: true,
    })
  }

  // Unverified L/M mappings may be invalidated by changed evaluation criteria.
  if (diff.changedEvaluation.length > 0) {
    const unverified = await prisma.sectionLmMapping.count({
      where: { consultingFirmId, opportunityId, verification: MappingVerification.UNVERIFIED },
    })
    if (unverified > 0) {
      impacts.push({
        consultingFirmId, revisionId, opportunityId,
        area: AmendmentImpactArea.OTHER,
        targetType: 'SectionLmMapping',
        targetId: null,
        targetLabel: `${unverified} unverified L/M mapping(s)`,
        impact: 'Evaluation criteria changed, so unconfirmed Section L/M mappings may no longer be correct.',
        recommendedAction: 'Re-derive mappings and review them. Confirmed mappings have not been changed.',
        reviewRequired: true,
      })
    }
  }

  if (impacts.length === 0) return 0
  const result = await prisma.amendmentImpact.createMany({ data: impacts })
  return result.count
}

/** Notify the people responsible. Deduped per revision per user. */
async function notifyAmendmentOwners(
  consultingFirmId: string,
  opportunityId: string,
  revisionId: string,
  revisionNo: number,
  diff: DeterministicDiff,
  now: Date,
): Promise<number> {
  const [pursuits, requirements, submission] = await Promise.all([
    prisma.bidPursuit.findMany({ where: { consultingFirmId, opportunityId, ownerUserId: { not: null } }, select: { ownerUserId: true } }),
    prisma.matrixRequirement.findMany({ where: { matrix: { opportunityId }, ownerUserId: { not: null } }, select: { ownerUserId: true }, take: 200 }),
    prisma.proposalSubmission.findFirst({ where: { consultingFirmId, opportunityId }, select: { ownerUserId: true } }),
  ])

  const recipients = new Set<string>()
  pursuits.forEach((p) => p.ownerUserId && recipients.add(p.ownerUserId))
  requirements.forEach((r) => r.ownerUserId && recipients.add(r.ownerUserId))
  if (submission?.ownerUserId) recipients.add(submission.ownerUserId)

  let notified = 0
  for (const userId of recipients) {
    try {
      await notifyUser({
        consultingFirmId,
        userId,
        type: NotificationType.AMENDMENT_ALERT,
        title: `Amendment ${revisionNo} recorded`,
        body: diff.summary,
        linkPath: `/opportunities/${opportunityId}`,
        entityType: 'AmendmentRevision',
        entityId: revisionId,
        // One notification per user per revision, ever.
        dedupeKey: `amendment:${revisionId}:${userId}`,
      })
      notified++
    } catch (err) {
      logger.warn('Amendment notification failed', { userId, revisionId, error: (err as Error).message })
    }
  }
  return notified
}

/** Acknowledge a revision and its impacts. */
export async function acknowledgeRevision(consultingFirmId: string, revisionId: string, userId: string, now: Date = new Date()) {
  const revision = await prisma.amendmentRevision.findFirst({ where: { id: revisionId, consultingFirmId }, select: { id: true } })
  if (!revision) throw new Error('Amendment revision not found')
  await prisma.amendmentRevision.update({
    where: { id: revision.id },
    data: { acknowledgedByUserId: userId, acknowledgedAt: now },
  })
  return prisma.amendmentImpact.updateMany({
    where: { revisionId: revision.id, acknowledgedAt: null },
    data: { acknowledgedByUserId: userId, acknowledgedAt: now },
  })
}
