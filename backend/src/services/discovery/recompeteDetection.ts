// =============================================================
// §6.1C — Re-compete detection.
//
// Deterministic: identical inputs always produce an identical signal, so the
// same scan run twice writes the same row rather than a second alert.
//
// What this deliberately does NOT do:
//  - claim a re-compete is certain (confidence is always graded evidence)
//  - fabricate an expected solicitation date (it emits a WINDOW, computed from
//    the real period-of-performance end minus a configurable lead time)
//  - ignore option periods (base-period expiry and final possible expiry are
//    tracked and reported separately)
//
// Sources of period-of-performance evidence, in priority order:
//   1. Contract + ContractOptionPeriod  (Section 5 post-award records — exact)
//   2. AwardHistory.baseAndAllOptions + award date (external award evidence)
// =============================================================
import { EvidenceConfidence, RecompeteVerification } from '@prisma/client'
import { prisma } from '../../config/database'

export const DETECTION_METHOD = 'deterministic-pop-v1'
export const METHOD_VERSION = 'v1'
/** Default lead time before PoP end at which a re-compete window opens. */
export const DEFAULT_LEAD_DAYS = 365
/** Signals are only emitted for expiries inside this forward horizon. */
export const DEFAULT_HORIZON_DAYS = 730

export interface PopEvidence {
  kind: 'CONTRACT' | 'AWARD_HISTORY'
  recordId: string
  fields: Record<string, unknown>
  note: string
}

export interface RecompeteComputation {
  windowStart: Date | null
  windowEnd: Date | null
  /** Base-period end — distinct from the final possible expiry. */
  basePeriodEnd: Date | null
  /** End including every un-exercised option period. */
  finalPossibleEnd: Date | null
  optionPeriodCount: number
  optionPeriodsRemaining: number
  confidence: EvidenceConfidence
  confidenceReason: string
  evidence: PopEvidence[]
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000)
}

/**
 * Compute the re-compete window from a contract's own period of performance.
 *
 * The window opens `leadDays` before the FINAL possible expiry (an agency
 * cannot re-compete before the incumbent's options are exhausted) and closes at
 * that expiry. Base-period end is reported separately because it is the earlier,
 * weaker signal — an unexercised option can end the contract there instead.
 */
export function computeFromContract(contract: {
  id: string
  contractNumber: string
  startDate: Date | null
  endDate: Date | null
  optionPeriods: Array<{ id: string; label: string; endDate: Date | null; exerciseStatus: string }>
}, leadDays: number): RecompeteComputation {
  const basePeriodEnd = contract.endDate
  const options = contract.optionPeriods
  const remaining = options.filter((o) => o.exerciseStatus === 'PLANNED' || o.exerciseStatus === 'PENDING_DECISION')

  const optionEnds = options.map((o) => o.endDate).filter((d): d is Date => d instanceof Date)
  const finalPossibleEnd = optionEnds.length > 0
    ? new Date(Math.max(...optionEnds.map((d) => d.getTime()), basePeriodEnd?.getTime() ?? 0))
    : basePeriodEnd

  const evidence: PopEvidence[] = [{
    kind: 'CONTRACT',
    recordId: contract.id,
    fields: {
      contractNumber: contract.contractNumber,
      startDate: contract.startDate?.toISOString() ?? null,
      basePeriodEnd: basePeriodEnd?.toISOString() ?? null,
      optionPeriodCount: options.length,
      optionPeriodsRemaining: remaining.length,
      finalPossibleEnd: finalPossibleEnd?.toISOString() ?? null,
    },
    note: 'Period of performance read directly from the tracked contract record and its option periods.',
  }]

  if (!finalPossibleEnd) {
    return {
      windowStart: null, windowEnd: null, basePeriodEnd, finalPossibleEnd: null,
      optionPeriodCount: options.length, optionPeriodsRemaining: remaining.length,
      confidence: EvidenceConfidence.NOT_AVAILABLE,
      confidenceReason: 'The contract record has no end date and no dated option periods, so no re-compete window can be estimated.',
      evidence,
    }
  }

  // A contract with a known end date and fully enumerated options is the
  // strongest evidence available; unexercised options make timing less certain.
  const confidence = remaining.length === 0
    ? EvidenceConfidence.CONFIRMED
    : EvidenceConfidence.PROBABLE
  const confidenceReason = remaining.length === 0
    ? 'End date is fixed and every option period is resolved, so the final expiry is known from the contract record.'
    : `${remaining.length} option period(s) are still unresolved, so the contract may end at the base period instead of the final possible expiry.`

  return {
    windowStart: addDays(finalPossibleEnd, -leadDays),
    windowEnd: finalPossibleEnd,
    basePeriodEnd,
    finalPossibleEnd,
    optionPeriodCount: options.length,
    optionPeriodsRemaining: remaining.length,
    confidence,
    confidenceReason,
    evidence,
  }
}

/** Typical federal base + 4 option years when the source gives only an award date. */
export const ASSUMED_TOTAL_TERM_YEARS = 5

/**
 * Compute from external award evidence. Award feeds rarely publish a period of
 * performance, so this is explicitly AMBIGUOUS and the assumption is stated in
 * the evidence rather than presented as a known date.
 */
export function computeFromAward(award: {
  id: string
  contractNumber: string | null
  recipientName: string
  awardDate: Date
  baseAndAllOptions: unknown
  awardAmount: unknown
}, leadDays: number): RecompeteComputation {
  const assumedEnd = new Date(award.awardDate)
  assumedEnd.setUTCFullYear(assumedEnd.getUTCFullYear() + ASSUMED_TOTAL_TERM_YEARS)

  const evidence: PopEvidence[] = [{
    kind: 'AWARD_HISTORY',
    recordId: award.id,
    fields: {
      contractNumber: award.contractNumber,
      recipientName: award.recipientName,
      awardDate: award.awardDate.toISOString(),
      awardAmount: award.awardAmount === null || award.awardAmount === undefined ? null : String(award.awardAmount),
      baseAndAllOptions: award.baseAndAllOptions === null || award.baseAndAllOptions === undefined ? null : String(award.baseAndAllOptions),
    },
    note:
      `The award record publishes no period of performance. The window below assumes a ${ASSUMED_TOTAL_TERM_YEARS}-year base-plus-options term from the award date. ` +
      'This is an assumption, not a published expiry date.',
  }]

  return {
    windowStart: addDays(assumedEnd, -leadDays),
    windowEnd: assumedEnd,
    // No published base-period end exists, so it is null rather than guessed.
    basePeriodEnd: null,
    finalPossibleEnd: assumedEnd,
    optionPeriodCount: 0,
    optionPeriodsRemaining: 0,
    confidence: EvidenceConfidence.AMBIGUOUS,
    confidenceReason:
      'Derived from award history with no published period of performance. The expiry is assumed, so this signal is indicative only.',
    evidence,
  }
}

export interface DetectionOptions {
  leadDays?: number
  horizonDays?: number
  now?: Date
}

/**
 * Scan a firm's contracts and award history and upsert re-compete signals.
 *
 * Idempotent by construction: the unique key is
 * (firm, method, sourceContract, sourceOpportunity, sourceAwardRef), so a
 * repeated scan updates the same row. A signal a human has VERIFIED, CORRECTED
 * or DISMISSED keeps their values — only the machine-side recalculation stamp
 * and the preserved original are touched.
 */
export async function detectRecompetes(
  consultingFirmId: string,
  options: DetectionOptions = {},
): Promise<{ contractsScanned: number; awardsScanned: number; created: number; updated: number; skippedVerified: number }> {
  const now = options.now ?? new Date()
  const leadDays = options.leadDays ?? DEFAULT_LEAD_DAYS
  const horizonDays = options.horizonDays ?? DEFAULT_HORIZON_DAYS
  const horizon = addDays(now, horizonDays)

  let created = 0
  let updated = 0
  let skippedVerified = 0

  const contracts = await prisma.contract.findMany({
    where: {
      consultingFirmId,
      isArchived: false,
      status: { in: ['ACTIVE', 'ON_HOLD'] },
    },
    select: {
      id: true, contractNumber: true, title: true, agency: true, startDate: true, endDate: true,
      opportunityId: true,
      optionPeriods: { select: { id: true, label: true, endDate: true, exerciseStatus: true } },
      opportunity: { select: { naicsCode: true, psc: true } },
    },
    take: 1000,
  })

  for (const contract of contracts) {
    const computed = computeFromContract(contract, leadDays)
    if (!computed.windowEnd || computed.windowEnd > horizon) continue

    const incumbent = await prisma.awardHistory.findFirst({
      where: { opportunityId: contract.opportunityId ?? '__none__' },
      orderBy: { awardDate: 'desc' },
      select: { recipientName: true, recipientUei: true },
    })

    const result = await upsertSignal(consultingFirmId, {
      sourceContractId: contract.id,
      sourceOpportunityId: null,
      sourceAwardRef: null,
      incumbentName: incumbent?.recipientName ?? null,
      incumbentUei: incumbent?.recipientUei ?? null,
      agency: contract.agency,
      contractNumber: contract.contractNumber,
      naicsCode: contract.opportunity?.naicsCode ?? null,
      psc: contract.opportunity?.psc ?? null,
      popStartDate: contract.startDate,
      relatedOpportunityId: contract.opportunityId,
    }, computed, leadDays, now)

    if (result === 'created') created++
    else if (result === 'updated') updated++
    else skippedVerified++
  }

  // External award evidence for opportunities that have no tracked contract.
  const awards = await prisma.awardHistory.findMany({
    where: {
      opportunity: { consultingFirmId, isDemo: false, contract: null },
      contractNumber: { not: null },
    },
    select: {
      id: true, contractNumber: true, recipientName: true, recipientUei: true,
      awardDate: true, baseAndAllOptions: true, awardAmount: true,
      awardingAgency: true, naics: true, psc: true, opportunityId: true,
    },
    orderBy: { awardDate: 'desc' },
    take: 500,
  })

  // One signal per contract number — the most recent award wins.
  const seenContractNumbers = new Set<string>()
  for (const award of awards) {
    const key = award.contractNumber as string
    if (seenContractNumbers.has(key)) continue
    seenContractNumbers.add(key)

    const computed = computeFromAward(award, leadDays)
    if (!computed.windowEnd || computed.windowEnd > horizon) continue

    const result = await upsertSignal(consultingFirmId, {
      sourceContractId: null,
      sourceOpportunityId: null,
      sourceAwardRef: key,
      incumbentName: award.recipientName,
      incumbentUei: award.recipientUei,
      agency: award.awardingAgency,
      contractNumber: key,
      naicsCode: award.naics,
      psc: award.psc,
      popStartDate: award.awardDate,
      relatedOpportunityId: award.opportunityId,
    }, computed, leadDays, now)

    if (result === 'created') created++
    else if (result === 'updated') updated++
    else skippedVerified++
  }

  return { contractsScanned: contracts.length, awardsScanned: awards.length, created, updated, skippedVerified }
}

interface SignalIdentity {
  sourceContractId: string | null
  sourceOpportunityId: string | null
  sourceAwardRef: string | null
  incumbentName: string | null
  incumbentUei: string | null
  agency: string | null
  contractNumber: string | null
  naicsCode: string | null
  psc: string | null
  popStartDate: Date | null
  relatedOpportunityId: string | null
}

async function upsertSignal(
  consultingFirmId: string,
  identity: SignalIdentity,
  computed: RecompeteComputation,
  leadDays: number,
  now: Date,
): Promise<'created' | 'updated' | 'preserved'> {
  const existing = await prisma.recompeteSignal.findFirst({
    where: {
      consultingFirmId,
      detectionMethod: DETECTION_METHOD,
      sourceContractId: identity.sourceContractId,
      sourceOpportunityId: identity.sourceOpportunityId,
      sourceAwardRef: identity.sourceAwardRef,
    },
  })

  const machineFields = {
    windowStart: computed.windowStart,
    windowEnd: computed.windowEnd,
    popEndDate: computed.basePeriodEnd,
    finalPossibleEndDate: computed.finalPossibleEnd,
    optionPeriodCount: computed.optionPeriodCount,
    optionPeriodsRemaining: computed.optionPeriodsRemaining,
    confidence: computed.confidence,
    confidenceReason: computed.confidenceReason,
    evidence: JSON.parse(JSON.stringify(computed.evidence)),
  }

  if (!existing) {
    await prisma.recompeteSignal.create({
      data: {
        consultingFirmId,
        ...identity,
        ...machineFields,
        leadDays,
        detectionMethod: DETECTION_METHOD,
        methodVersion: METHOD_VERSION,
        lastCalculatedAt: now,
        // Preserve the first machine result for comparison after any human edit.
        originalWindowStart: computed.windowStart,
        originalWindowEnd: computed.windowEnd,
        originalConfidence: computed.confidence,
      },
    })
    return 'created'
  }

  // A human decision is authoritative. Only the recalculation stamp is updated
  // so the UI can still show when the machine last looked.
  if (existing.verification !== RecompeteVerification.UNVERIFIED) {
    await prisma.recompeteSignal.update({
      where: { id: existing.id },
      data: { lastCalculatedAt: now },
    })
    return 'preserved'
  }

  await prisma.recompeteSignal.update({
    where: { id: existing.id },
    data: {
      ...identity,
      ...machineFields,
      leadDays,
      lastCalculatedAt: now,
      originalWindowStart: existing.originalWindowStart ?? computed.windowStart,
      originalWindowEnd: existing.originalWindowEnd ?? computed.windowEnd,
      originalConfidence: existing.originalConfidence ?? computed.confidence,
    },
  })
  return 'updated'
}
