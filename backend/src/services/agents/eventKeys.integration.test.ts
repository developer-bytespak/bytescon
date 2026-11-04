// =============================================================
// B10, B11 — agent events and the entity types they carry.
//
// B10: a retried request used to start extra agent runs, because the event key
// held Date.now(). Now it holds the row's previous version: a duplicate is
// dropped and a genuine repeat still fires.
// B11: Proposal and Pricing looked for 'ExtractionJob' and 'Amendment', but
// events carry 'SolicitationExtractionJob' and 'AmendmentRevision', so they
// re-checked the whole firm instead of the one opportunity.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '../../config/database'
import { createTestFirm, cleanupFirm, disconnectDb, type TestFirm } from '../../test-utils/testClient'
import { emitBidDecisionRecorded } from './teaming/teamingEvents'
import { emitProposalSectionApproved } from './proposal/proposalEvents'
import { emitTimeEntrySubmitted } from './finance/financeEvents'
import { emitSubmissionOutcomeRecorded } from './intelligence/intelligenceEvents'
import { AMENDMENT_ENTITY_TYPE, EXTRACTION_JOB_ENTITY_TYPE } from './compliance/complianceEvents'
import { isAmendmentTrigger, opportunityIdForTrigger } from './triggerEntities'
import { phasesForRun as pricingPhases } from './pricing/pricingAgentHandler'

let firmA: TestFirm
let firmB: TestFirm
let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`
const OLD = new Date(1_000)
const NEW = new Date(2_000)

beforeAll(async () => {
  firmA = await createTestFirm({ name: 'Event Keys Firm A' })
  firmB = await createTestFirm({ name: 'Event Keys Firm B' })
})

afterAll(async () => {
  await prisma.agentEvent.deleteMany({ where: { consultingFirmId: { in: [firmA.id, firmB.id] } } })
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

const opportunityOf = (firmId: string) =>
  prisma.opportunity.create({
    data: { consultingFirmId: firmId, title: uniq('Event keys opp'), agency: 'GSA', naicsCode: '541512', setAsideType: 'NONE', marketCategory: 'SERVICES', estimatedValue: 1000, responseDeadline: new Date(Date.now() + 86_400_000) },
  })

describe('a retried request (B10)', () => {
  const firm = () => firmA.id
  const cases: Array<[string, (version: Date) => (tx: Parameters<typeof emitBidDecisionRecorded>[1]) => Promise<{ created: boolean }>]> = [
    ['bid decision', (v) => (tx) => emitBidDecisionRecorded({
      consultingFirmId: firm(), pursuitId: 'p-b10', opportunityId: 'o', decision: 'GO', isOverride: false, decidedByUserId: 'u', previousUpdatedAt: v,
    } as never, tx)],
    ['section approval', (v) => (tx) => emitProposalSectionApproved({
      consultingFirmId: firm(), proposalSectionId: 's-b10', opportunityId: 'o', proposalId: null, approvedByUserId: 'u', previousUpdatedAt: v,
    }, tx)],
    ['time entry', (v) => (tx) => emitTimeEntrySubmitted(tx, {
      consultingFirmId: firm(), contractId: 'c', timeEntryId: 't-b10', workDate: new Date(), previousUpdatedAt: v,
    } as never)],
    ['outcome correction', (v) => (tx) => emitSubmissionOutcomeRecorded(tx as never, {
      consultingFirmId: firm(), submissionRecordId: 'r-b10', opportunityId: 'o', fromOutcome: 'LOST', toOutcome: 'WON', recordedByUserId: 'u', previousRecordedAt: v,
    } as never)],
  ]

  it.each(cases)('%s: a duplicate is dropped, a genuine repeat fires', async (_name, emit) => {
    await prisma.$transaction(async (tx) => {
      expect((await emit(OLD)(tx)).created).toBe(true)
      expect((await emit(OLD)(tx)).created).toBe(false)
      expect((await emit(NEW)(tx)).created).toBe(true)
    })
  })
})

describe('the entity types events carry (B11)', () => {
  it('recognises the real amendment type, so Pricing runs only its amendment phases', () => {
    expect(isAmendmentTrigger(AMENDMENT_ENTITY_TYPE)).toBe(true)
    expect(pricingPhases(AMENDMENT_ENTITY_TYPE)).toContain('CHECK_AMENDMENT_IMPACT')
    expect(pricingPhases(AMENDMENT_ENTITY_TYPE)).not.toContain('BUILD_PUBLIC_AWARD_COHORT')
  })

  it('finds the opportunity of an amendment revision, for its own firm only', async () => {
    const opp = await opportunityOf(firmA.id)
    const revision = await prisma.amendmentRevision.create({
      data: { consultingFirmId: firmA.id, opportunityId: opp.id, revisionNo: 1, contentHash: uniq('hash') },
    })
    expect(await opportunityIdForTrigger(firmA.id, AMENDMENT_ENTITY_TYPE, revision.id)).toBe(opp.id)
    expect(await opportunityIdForTrigger(firmB.id, AMENDMENT_ENTITY_TYPE, revision.id)).toBeNull()
  })

  it('finds the opportunity of a legacy Amendment row, for its own firm only', async () => {
    const opp = await opportunityOf(firmA.id)
    const amendment = await prisma.amendment.create({ data: { opportunityId: opp.id, title: 'Legacy' } })
    expect(await opportunityIdForTrigger(firmA.id, 'Amendment', amendment.id)).toBe(opp.id)
    expect(await opportunityIdForTrigger(firmB.id, 'Amendment', amendment.id)).toBeNull()
  })

  it('finds the opportunity of an extraction job, for its own firm only', async () => {
    const opp = await opportunityOf(firmA.id)
    const matrix = await prisma.complianceMatrix.create({ data: { consultingFirmId: firmA.id, opportunityId: opp.id } as never })
    const job = await prisma.solicitationExtractionJob.create({
      data: {
        consultingFirmId: firmA.id, opportunityId: opp.id, complianceMatrixId: matrix.id,
        idempotencyKey: uniq('job'), status: 'FAILED', parseMethod: 'DETERMINISTIC',
        extractorVersion: 'v1', sourceHash: uniq('hash'), attempt: 1, maxAttempts: 3,
      } as never,
    })
    expect(await opportunityIdForTrigger(firmA.id, EXTRACTION_JOB_ENTITY_TYPE, job.id)).toBe(opp.id)
    expect(await opportunityIdForTrigger(firmB.id, EXTRACTION_JOB_ENTITY_TYPE, job.id)).toBeNull()
  })

  it('returns nothing for an unknown id', async () => {
    expect(await opportunityIdForTrigger(firmA.id, AMENDMENT_ENTITY_TYPE, 'missing')).toBeNull()
    expect(await opportunityIdForTrigger(firmA.id, AMENDMENT_ENTITY_TYPE, null)).toBeNull()
  })
})
