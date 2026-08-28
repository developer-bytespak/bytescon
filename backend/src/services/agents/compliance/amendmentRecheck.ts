// =============================================================
// §7.3 — Amendment re-check.
//
// The proposal's fifth compliance requirement: "automatically re-check
// compliance whenever an amendment is issued."
//
// WHAT THIS DOES NOT DO
// It does not diff amendments — §6.4B's `diffAmendmentText` already does, and
// it does not persist revisions or impacts — §6.4B's `recordAmendmentRevision`
// already does. Both are reused. This module reads what that canonical path
// produced and answers the question it does not: given this amendment, what is
// now unresolved, what conflicts with something a human already verified, and
// is the deadline close enough that a human must be told now rather than at the
// next sweep.
//
// PROMPT INTEGRITY
// The canonical amendment system prompt is imported from ONE place —
// `services/requirements/extractionPrompts.ts` — and is never copied,
// paraphrased, extended or concatenated with agent instructions. This module
// holds no prompt text of its own. A regression test asserts that the compliance
// directory contains no prompt literal.
//
// HUMAN-VERIFIED DATA IS NEVER OVERWRITTEN. Where amendment evidence conflicts
// with a verified requirement or clause, the verified row is left exactly as it
// is and the conflict is reported for a human to resolve.
// =============================================================
import { MappingVerification } from '@prisma/client'
import { prisma } from '../../../config/database'
import {
  AMENDMENT_CHANGE_SUMMARY_SYSTEM_PROMPT,
  AMENDMENT_SUMMARY_PROMPT_VERSION,
} from '../../requirements/extractionPrompts'
import { workingDaysBetween } from '../../milestones/workingDays'
import { buildWorkingCalendar } from '../workingCalendar'
import { AMENDMENT_DEADLINE_WORKING_DAYS, FLOW_DOWN_REVIEW_WORDING } from './policy'
import type { ProposedEscalation } from '../types'

/**
 * The canonical amendment prompt, re-exported by reference so any caller in the
 * compliance layer resolves to the ONE authoritative constant. Re-exporting a
 * binding copies no bytes: `AMENDMENT_CHANGE_SUMMARY_SYSTEM_PROMPT` here and in
 * extractionPrompts.ts are the same string instance, which the tests assert.
 */
export { AMENDMENT_CHANGE_SUMMARY_SYSTEM_PROMPT, AMENDMENT_SUMMARY_PROMPT_VERSION }

export interface AmendmentConflict {
  kind: 'VERIFIED_REQUIREMENT' | 'VERIFIED_CLAUSE' | 'CONFIRMED_MAPPING'
  entityId: string
  label: string
  /** The value that was preserved. Never changed by this module. */
  preservedValue: string
  /** What the amendment appears to say instead. */
  proposedValue: string
  resolution: string
}

export interface AmendmentRecheckResult {
  opportunityId: string
  latestRevisionId: string | null
  latestRevisionNo: number | null
  amendmentNumber: string | null
  recordedAt: Date | null
  comparable: boolean
  changedRequirements: number
  changedClauses: number
  changedLmCriteria: number
  changedDeadlines: number
  changedAttachments: number
  newQuestionsAndAnswers: number
  unresolvedImpacts: number
  acknowledgedImpacts: number
  /** Verified records the amendment appears to contradict. All preserved. */
  conflicts: AmendmentConflict[]
  responseDeadline: Date | null
  workingDaysToDeadline: number | null
  withinDeadlineWindow: boolean
  humanReviewRequired: boolean
  promptVersion: string
  /** Honest note about whether AI enrichment contributed. */
  analysisBasis: string
  escalations: ProposedEscalation[]
  warnings: string[]
  dataLimitations: string[]
}

export function amendmentEscalationDedupeHint(revisionId: string, condition: 'DEADLINE' | 'CONFLICT'): string {
  return `compliance-amendment-${condition.toLowerCase()}:${revisionId}`
}

/**
 * Re-check compliance for one opportunity against its latest recorded amendment.
 *
 * Read-only with respect to every human-owned record. It creates no revision and
 * no impact — `recordAmendmentRevision` owns that — so running it twice is
 * inherently safe and produces no duplicate impact rows.
 */
export async function recheckAmendmentCompliance(args: {
  consultingFirmId: string
  opportunityId: string
  now?: Date
}): Promise<AmendmentRecheckResult> {
  const now = args.now ?? new Date()
  const { consultingFirmId, opportunityId } = args

  const [opportunity, revision] = await Promise.all([
    prisma.opportunity.findFirst({
      where: { id: opportunityId, consultingFirmId },
      select: { id: true, responseDeadline: true },
    }),
    prisma.amendmentRevision.findFirst({
      where: { consultingFirmId, opportunityId },
      orderBy: { revisionNo: 'desc' },
    }),
  ])

  const warnings: string[] = []
  const dataLimitations: string[] = []
  const escalations: ProposedEscalation[] = []

  if (!revision) {
    return {
      opportunityId,
      latestRevisionId: null, latestRevisionNo: null, amendmentNumber: null, recordedAt: null,
      comparable: false,
      changedRequirements: 0, changedClauses: 0, changedLmCriteria: 0, changedDeadlines: 0,
      changedAttachments: 0, newQuestionsAndAnswers: 0,
      unresolvedImpacts: 0, acknowledgedImpacts: 0,
      conflicts: [],
      responseDeadline: opportunity?.responseDeadline ?? null,
      workingDaysToDeadline: null, withinDeadlineWindow: false,
      humanReviewRequired: false,
      promptVersion: AMENDMENT_SUMMARY_PROMPT_VERSION,
      analysisBasis: 'No amendment has been recorded for this opportunity.',
      escalations, warnings,
      dataLimitations: ['No amendment revision exists, so no amendment re-check was possible.'],
    }
  }

  // The §6.4B diff is already persisted on the revision. It is READ here, not
  // recomputed, so the agent and the amendment view can never disagree.
  const changedRequirements = countJsonArray(revision.changedRequirements)
  const changedClauses = countJsonArray(revision.changedClauses)
  const changedLmCriteria = countJsonArray(revision.changedEvaluation)
  const changedDeadlines = countJsonArray(revision.changedDeadlines)
  const changedAttachments = countJsonArray(revision.changedAttachments)
  const newQuestionsAndAnswers = countJsonArray(revision.questionsAndAnswers)

  const diffSummary = (revision.diffSummary ?? {}) as { comparable?: boolean; summary?: string }
  const comparable = diffSummary.comparable === true
  if (!comparable) {
    dataLimitations.push(
      'The prior solicitation text was not retained, so this revision was recorded as a baseline rather than compared line by line.',
    )
  }

  const [unresolvedImpacts, acknowledgedImpacts] = await Promise.all([
    prisma.amendmentImpact.count({ where: { consultingFirmId, revisionId: revision.id, acknowledgedAt: null } }),
    prisma.amendmentImpact.count({ where: { consultingFirmId, revisionId: revision.id, acknowledgedAt: { not: null } } }),
  ])

  const conflicts = await findVerifiedConflicts(consultingFirmId, opportunityId, revision)

  // --- deadline proximity, in WORKING days ---------------------------
  const responseDeadline = opportunity?.responseDeadline ?? null
  let workingDaysToDeadline: number | null = null
  let withinDeadlineWindow = false
  if (responseDeadline && responseDeadline.getTime() >= now.getTime()) {
    const calendar = await buildWorkingCalendar(consultingFirmId, now)
    workingDaysToDeadline = workingDaysBetween(now, responseDeadline, calendar)
    withinDeadlineWindow = workingDaysToDeadline <= AMENDMENT_DEADLINE_WORKING_DAYS
  }

  if (withinDeadlineWindow) {
    escalations.push({
      severity: workingDaysToDeadline !== null && workingDaysToDeadline <= 2 ? 'CRITICAL' : 'HIGH',
      title: `Amendment ${revision.revisionNo} issued ${workingDaysToDeadline} working day(s) before the deadline`,
      reason:
        `Amendment revision ${revision.revisionNo}${revision.amendmentNumber ? ` (${revision.amendmentNumber})` : ''} was recorded with only ` +
        `${workingDaysToDeadline} working day(s) until the response deadline on ${responseDeadline?.toISOString().slice(0, 10)} ` +
        '(weekends and US federal holidays excluded). ' +
        `${changedRequirements} requirement change(s), ${changedDeadlines} deadline change(s) and ${changedClauses} clause change(s) are recorded, ` +
        `with ${unresolvedImpacts} impact(s) still unacknowledged.`,
      recommendedAction: 'Review the amendment impacts now and confirm the submission can still be met. The agent never acknowledges an amendment for you.',
      entityType: 'AmendmentRevision',
      entityId: revision.id,
      dedupeHint: amendmentEscalationDedupeHint(revision.id, 'DEADLINE'),
    })
  }

  if (conflicts.length > 0) {
    escalations.push({
      severity: 'HIGH',
      title: `Amendment ${revision.revisionNo} conflicts with ${conflicts.length} human-verified record(s)`,
      reason:
        `This amendment appears to change ${conflicts.length} record(s) a human has already verified. ` +
        'Every verified value has been PRESERVED unchanged; the differences are recorded for you to resolve.',
      recommendedAction: 'Compare each verified record against the amendment and update it yourself if it should change.',
      entityType: 'AmendmentRevision',
      entityId: revision.id,
      dedupeHint: amendmentEscalationDedupeHint(revision.id, 'CONFLICT'),
    })
  }

  if (revision.humanReviewRequired && unresolvedImpacts > 0) {
    warnings.push(`${unresolvedImpacts} amendment impact(s) are awaiting human acknowledgement.`)
  }

  // Honest statement of what produced the analysis. The AI summary is optional
  // and additive; the deterministic diff is always what is reported here.
  const analysisBasis = revision.aiSummaryJson
    ? `Deterministic §6.4B comparison, enriched by the canonical amendment analysis prompt (${AMENDMENT_SUMMARY_PROMPT_VERSION}).`
    : `Deterministic §6.4B comparison only. No AI amendment summary is stored for this revision, so no AI-derived claim is made. Prompt version on record: ${AMENDMENT_SUMMARY_PROMPT_VERSION}.`

  return {
    opportunityId,
    latestRevisionId: revision.id,
    latestRevisionNo: revision.revisionNo,
    amendmentNumber: revision.amendmentNumber,
    recordedAt: revision.firstSeenAt,
    comparable,
    changedRequirements, changedClauses, changedLmCriteria,
    changedDeadlines, changedAttachments, newQuestionsAndAnswers,
    unresolvedImpacts, acknowledgedImpacts,
    conflicts,
    responseDeadline,
    workingDaysToDeadline,
    withinDeadlineWindow,
    // Never auto-cleared. §6.4B sets this true on every revision and only a
    // human acknowledgement changes it.
    humanReviewRequired: revision.humanReviewRequired,
    promptVersion: AMENDMENT_SUMMARY_PROMPT_VERSION,
    analysisBasis,
    escalations, warnings, dataLimitations,
  }
}

function countJsonArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

/**
 * Find records a human verified that this amendment appears to contradict.
 *
 * Detection only. Nothing is written: the verified row keeps its value and the
 * difference is surfaced. This is the guarantee §7.3 requires — an amendment can
 * never silently rewrite verified truth.
 */
async function findVerifiedConflicts(
  consultingFirmId: string,
  opportunityId: string,
  revision: { id: string; changedRequirements: unknown; changedClauses: unknown },
): Promise<AmendmentConflict[]> {
  const conflicts: AmendmentConflict[] = []

  const changedRequirements = (Array.isArray(revision.changedRequirements) ? revision.changedRequirements : []) as Array<{
    changeType?: string; priorText?: string | null; newText?: string | null
  }>
  const changedClauses = (Array.isArray(revision.changedClauses) ? revision.changedClauses : []) as Array<{
    clauseNumber?: string; changeType?: string; priorText?: string | null; newText?: string | null; flowDownImpact?: string | null
  }>

  // --- verified requirements the amendment reports as REMOVED or MODIFIED ---
  const removedOrModified = changedRequirements.filter((r) => r.changeType === 'REMOVED' || r.changeType === 'MODIFIED')
  if (removedOrModified.length > 0) {
    const verified = await prisma.matrixRequirement.findMany({
      where: { consultingFirmId, matrix: { opportunityId }, isManuallyVerified: true },
      select: { id: true, section: true, requirementText: true },
      take: 500,
    })
    for (const change of removedOrModified) {
      const priorText = (change.priorText ?? '').trim()
      if (!priorText) continue
      const match = verified.find((v) => normalise(v.requirementText) === normalise(priorText))
      if (!match) continue
      conflicts.push({
        kind: 'VERIFIED_REQUIREMENT',
        entityId: match.id,
        label: `${match.section}: ${match.requirementText.slice(0, 120)}`,
        preservedValue: match.requirementText,
        proposedValue: change.newText ?? '(the amendment appears to remove this requirement)',
        resolution:
          'The verified requirement has been left exactly as it is. Review the amendment and change it yourself if it should change.',
      })
    }
  }

  // --- verified clauses the amendment reclassifies ------------------------
  if (changedClauses.length > 0) {
    const clauseNumbers = changedClauses.map((c) => c.clauseNumber).filter((n): n is string => Boolean(n))
    if (clauseNumbers.length > 0) {
      const verifiedClauses = await prisma.clauseObligation.findMany({
        where: { consultingFirmId, opportunityId, clauseNumber: { in: clauseNumbers }, isManuallyVerified: true },
        select: { id: true, clauseNumber: true, clauseTitle: true, flowDownStatus: true },
      })
      for (const clause of verifiedClauses) {
        const change = changedClauses.find((c) => c.clauseNumber === clause.clauseNumber)
        if (!change) continue
        conflicts.push({
          kind: 'VERIFIED_CLAUSE',
          entityId: clause.id,
          label: `${clause.clauseNumber}${clause.clauseTitle ? ` — ${clause.clauseTitle}` : ''}`,
          preservedValue: `flowDownStatus ${clause.flowDownStatus}`,
          proposedValue: change.flowDownImpact ?? change.newText ?? `${change.changeType} in this amendment`,
          resolution: `The verified clause is unchanged. ${FLOW_DOWN_REVIEW_WORDING}`,
        })
      }
    }
  }

  // --- confirmed L/M mappings invalidated by changed evaluation criteria ---
  const changedEvaluationCount = changedRequirements.filter((r) => r.changeType !== undefined).length
  if (changedEvaluationCount > 0) {
    const confirmed = await prisma.sectionLmMapping.findMany({
      where: { consultingFirmId, opportunityId, verification: MappingVerification.CONFIRMED },
      select: { id: true, instructionSourceSection: true, evaluationSourceSection: true },
      take: 100,
    })
    for (const mapping of confirmed) {
      conflicts.push({
        kind: 'CONFIRMED_MAPPING',
        entityId: mapping.id,
        label: `${mapping.instructionSourceSection} → ${mapping.evaluationSourceSection ?? 'unmapped'}`,
        preservedValue: 'CONFIRMED',
        proposedValue: 'The amendment changed requirement text this confirmed mapping was based on.',
        resolution: 'The confirmed mapping is unchanged. Re-check it against the amended text and re-confirm or reject it yourself.',
      })
    }
  }

  return conflicts
}

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}
