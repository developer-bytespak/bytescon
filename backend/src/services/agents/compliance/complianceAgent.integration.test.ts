// =============================================================
// §7.3 — Compliance Agent against a real PostgreSQL database.
//
// Covers the registry, phase selection and its loop guarantee, the handler,
// automatic extraction and its duplicate-prevention rule, human-verification
// protection, L/M bands, clause legal review, amendment re-check, registration/
// certification/insurance/bonding at their exact boundaries, the overall status
// decision, escalations and their dedupe, the human-control guarantees at both
// autonomy levels, tenant isolation, and the no-provider path.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Prisma } from '@prisma/client'

// The LLM provider boundary is mocked for the whole file. The agent must never
// reach it: every check it performs is deterministic.
const generateWithRouterSpy = vi.fn()
vi.mock('../../llm/llmRouter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../llm/llmRouter')>()
  return { ...actual, generateWithRouter: (...a: unknown[]) => generateWithRouterSpy(...a) }
})

import { prisma } from '../../../config/database'
import {
  createTestFirm, createTestUser, cleanupFirm, disconnectDb, type TestFirm, type TestUser,
} from '../../../test-utils/testClient'
import { dispatchAgentRun } from '../dispatch'
import { createRun } from '../runService'
import { getAgentDefinition, agentsSubscribedTo, AGENT_REGISTRY } from '../registry'
import { DOMAIN_AGENT_KEYS } from '../types'
import { resetWorkingCalendarCache } from '../workingCalendar'
import { runExtraction } from '../../requirements/extractionPipeline'
import { recordAmendmentRevision } from '../../milestones/amendmentMonitor'
import { COMPLIANCE_PHASES, phasesForRun } from './complianceAgentHandler'
import { DOCUMENT_ENTITY_TYPE, EXTRACTION_JOB_ENTITY_TYPE, AMENDMENT_ENTITY_TYPE } from './complianceEvents'
import { PURSUIT_ENTITY_TYPE } from '../opportunity/opportunityEvents'
import { assessRegistration, assessBonding } from './registrationWatch'
import { recheckAmendmentCompliance } from './amendmentRecheck'
import { SAM_EXPIRY_ESCALATION_DAYS, deriveOverallStatus, worstStatus } from './policy'

const AGENT = 'COMPLIANCE' as const
const DAY = 86_400_000

let firmA: TestFirm
let firmB: TestFirm
let adminA: TestUser
let ownerA: TestUser
let adminB: TestUser

let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

const SOLICITATION_TEXT = `
SECTION L — INSTRUCTIONS TO OFFERORS
L.1 The offeror shall submit a technical volume not exceeding 30 pages.
L.2 The offeror shall provide a signed SF-33 form with the proposal.
L.3 The offeror shall submit past performance references for three contracts.

SECTION M — EVALUATION FACTORS
M.1 The Government will evaluate the technical volume for completeness.
M.2 The Government will evaluate past performance relevance.

52.204-7 System for Award Management. The Contractor shall insert this clause in all subcontracts.
252.204-7012 Safeguarding Covered Defense Information.

Proposal Deadline: 2027-03-01
Question Deadline: 2027-02-01
`

beforeAll(async () => {
  firmA = await createTestFirm({ name: 'Compliance Agent Firm A' })
  firmB = await createTestFirm({ name: 'Compliance Agent Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  ownerA = await createTestUser(firmA.id, { role: 'CONSULTANT' })
  adminB = await createTestUser(firmB.id, { role: 'ADMIN' })
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

beforeEach(async () => {
  generateWithRouterSpy.mockReset()
  resetWorkingCalendarCache()
  for (const id of [firmA.id, firmB.id]) {
    await prisma.agentEscalation.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentRun.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentSchedule.deleteMany({ where: { consultingFirmId: id } })
    await prisma.userNotification.deleteMany({ where: { consultingFirmId: id } })
    await prisma.bondingCapacity.deleteMany({ where: { consultingFirmId: id } })
    await prisma.certification.deleteMany({ where: { consultingFirmId: id } })
    await prisma.insurancePolicy.deleteMany({ where: { consultingFirmId: id } })
    await prisma.registrationProfile.deleteMany({ where: { consultingFirmId: id } })
    await prisma.bidPursuit.deleteMany({ where: { consultingFirmId: id } })
    await prisma.opportunity.deleteMany({ where: { consultingFirmId: id } })
  }
})

// -------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------

async function makeOpportunity(firmId: string, over: Partial<Prisma.OpportunityUncheckedCreateInput> = {}) {
  return prisma.opportunity.create({
    data: {
      consultingFirmId: firmId,
      samNoticeId: uniq('S7-COMP-QA'),
      title: 'S7-COMP-QA cyber support solicitation',
      agency: 'Department of Defense',
      naicsCode: '541512',
      setAsideType: 'SDVOSB',
      description: SOLICITATION_TEXT,
      responseDeadline: new Date(Date.now() + 60 * DAY),
      status: 'ACTIVE',
      isDemo: false,
      ...over,
    },
  })
}

async function makeActivePursuit(firmId: string, opportunityId: string, stage: 'QUALIFICATION' | 'PROPOSAL' = 'PROPOSAL') {
  return prisma.bidPursuit.create({
    data: { consultingFirmId: firmId, opportunityId, pipelineStage: stage, status: 'REVIEWING' },
  })
}

async function makeDocument(firmId: string, opportunityId: string, text: string | null = SOLICITATION_TEXT) {
  return prisma.opportunityDocument.create({
    data: {
      opportunityId,
      fileName: uniq('S7-COMP-QA-doc') + '.pdf',
      storageKey: uniq('key'),
      fileType: 'application/pdf',
      fileSize: 1024,
      isAmendment: false,
      analysisStatus: text ? 'COMPLETE' : 'PENDING',
      extractionStatus: 'PENDING',
      ...(text ? { rawAnalysis: { text } as Prisma.InputJsonValue } : {}),
    },
  })
}

async function makeRegistration(firmId: string, over: Partial<Prisma.RegistrationProfileUncheckedCreateInput> = {}) {
  return prisma.registrationProfile.create({
    data: {
      consultingFirmId: firmId,
      samStatus: 'ACTIVE',
      samExpiryDate: new Date(Date.now() + 200 * DAY),
      uei: 'S7COMPQAUEI1',
      cageCode: '1QA23',
      reminderLeadDays: 60,
      ...over,
    },
  })
}

async function runAgent(firmId: string, over: Record<string, unknown> = {}) {
  const { run } = await createRun({
    consultingFirmId: firmId,
    agentKey: AGENT,
    triggerType: 'MANUAL',
    idempotencyKey: uniq('comp-run'),
    ...over,
  })
  await dispatchAgentRun(run.id)
  return prisma.agentRun.findUnique({ where: { id: run.id } })
}

async function latestStatus(firmId: string) {
  return prisma.agentArtifact.findFirst({
    where: { consultingFirmId: firmId, agentKey: AGENT, artifactType: 'COMPLIANCE_STATUS', supersededByArtifactId: null },
    orderBy: { createdAt: 'desc' },
  })
}

// -------------------------------------------------------------
// Registry
// -------------------------------------------------------------

describe('agent registry', () => {
  it('marks the Compliance Agent implemented with a real handler', () => {
    const def = getAgentDefinition(AGENT)!
    expect(def.implemented).toBe(true)
    expect(def.handler).not.toBeNull()
    expect(def.plannedSlice).toBe('7.3')
  })

  it('defaults to PROPOSE autonomy and stays opt-in', () => {
    const def = getAgentDefinition(AGENT)!
    expect(def.defaultAutonomyLevel).toBe('PROPOSE')
    expect(def.defaultEnabled).toBe(false)
  })

  it('does not require an LLM, so it is usable with no provider key', () => {
    const def = getAgentDefinition(AGENT)!
    expect(def.requiresLlm).toBe(false)
    expect(def.noLlmBehaviour).toMatch(/full function/i)
  })

  it('runs every six hours by default', () => {
    expect(getAgentDefinition(AGENT)!.defaultCronExpression).toBe('0 */6 * * *')
  })

  it('subscribes to the four §7.3 triggers, reusing PURSUIT_STAGE_CHANGED', () => {
    expect(getAgentDefinition(AGENT)!.subscribedEventTypes.sort()).toEqual([
      'AMENDMENT_RECORDED', 'EXTRACTION_COMPLETED', 'PURSUIT_STAGE_CHANGED', 'SOLICITATION_DOCUMENT_ADDED',
    ])
  })

  it.each(['SOLICITATION_DOCUMENT_ADDED', 'EXTRACTION_COMPLETED', 'AMENDMENT_RECORDED'])(
    'routes %s to the Compliance Agent',
    (eventType) => {
      expect(agentsSubscribedTo(eventType).map((d) => d.key)).toContain(AGENT)
    },
  )

  it('shares PURSUIT_STAGE_CHANGED with the Opportunity and Qualification Agents', () => {
    const keys = agentsSubscribedTo('PURSUIT_STAGE_CHANGED').map((d) => d.key).sort()
    expect(keys).toEqual(['COMPLIANCE', 'OPPORTUNITY', 'QUALIFICATION'])
  })

  it('allowlists no autonomous action keys', () => {
    expect(getAgentDefinition(AGENT)!.allowlistedActionKeys).toEqual([])
  })

  it('leaves the other two delivered agents implemented', () => {
    expect(getAgentDefinition('CONTRACT_ADMINISTRATION')!.implemented).toBe(true)
    expect(getAgentDefinition('OPPORTUNITY')!.implemented).toBe(true)
  })

  it('leaves no domain agent unimplemented — §7.9 completed Section 7', () => {
    const remaining = DOMAIN_AGENT_KEYS.filter((k) => !getAgentDefinition(k)!.implemented)
    expect(remaining).toEqual([])
    for (const key of DOMAIN_AGENT_KEYS) {
      expect(getAgentDefinition(key)!.handler, `${key} must have a real handler`).not.toBeNull()
    }
  })

  it('exposes exactly ten implemented entries — nine domain agents plus the diagnostic', () => {
    expect(AGENT_REGISTRY.filter((d) => d.implemented).map((d) => d.key).sort()).toEqual([
      'COMPLIANCE', 'CONTRACT_ADMINISTRATION', 'FINANCE', 'INTELLIGENCE', 'INTERNAL_DIAGNOSTIC', 'OPPORTUNITY', 'PRICING', 'PROPOSAL', 'QUALIFICATION', 'TEAMING',
    ])
  })
})

// -------------------------------------------------------------
// Phase selection + the loop guarantee
// -------------------------------------------------------------

describe('phase selection', () => {
  it('runs every phase except extraction for a scheduled sweep', () => {
    const phases = phasesForRun(null)
    expect(phases).not.toContain('RUN_EXTRACTION')
    expect(phases).toContain('CHECK_REGISTRATION')
    expect(phases).toContain('CHECK_BONDING')
    expect(phases).toContain('CHECK_AMENDMENT_IMPACTS')
  })

  it('is the ONLY trigger that may start an extraction: a new document', () => {
    expect(phasesForRun(DOCUMENT_ENTITY_TYPE)).toContain('RUN_EXTRACTION')
    for (const entity of [null, EXTRACTION_JOB_ENTITY_TYPE, AMENDMENT_ENTITY_TYPE, PURSUIT_ENTITY_TYPE]) {
      expect(phasesForRun(entity), `${entity} must not start an extraction`).not.toContain('RUN_EXTRACTION')
    }
  })

  it('makes the extraction event loop structurally impossible', () => {
    // EXTRACTION_COMPLETED → no RUN_EXTRACTION → no new extraction → no new
    // EXTRACTION_COMPLETED. The loop cannot start.
    const phases = phasesForRun(EXTRACTION_JOB_ENTITY_TYPE)
    expect(phases).not.toContain('RUN_EXTRACTION')
    expect(phases).toContain('DERIVE_LM_COVERAGE')
    expect(phases).toContain('CHECK_CLAUSE_OBLIGATIONS')
  })

  it('prioritises amendment work for an amendment trigger', () => {
    const phases = phasesForRun(AMENDMENT_ENTITY_TYPE)
    expect(phases).toContain('CHECK_AMENDMENT_IMPACTS')
    expect(phases).not.toContain('CHECK_BONDING')
  })

  it('runs pre-submission readiness for a pursuit-stage trigger', () => {
    expect(phasesForRun(PURSUIT_ENTITY_TYPE)).toContain('RUN_PRE_SUBMISSION_CHECKS')
  })

  it('keeps phases in canonical order regardless of trigger', () => {
    for (const entity of [null, DOCUMENT_ENTITY_TYPE, EXTRACTION_JOB_ENTITY_TYPE, AMENDMENT_ENTITY_TYPE, PURSUIT_ENTITY_TYPE]) {
      const indices = phasesForRun(entity).map((p) => COMPLIANCE_PHASES.indexOf(p))
      expect(indices).toEqual([...indices].sort((a, b) => a - b))
    }
  })

  it('always builds a status and completes', () => {
    for (const entity of [null, DOCUMENT_ENTITY_TYPE, EXTRACTION_JOB_ENTITY_TYPE, AMENDMENT_ENTITY_TYPE, PURSUIT_ENTITY_TYPE]) {
      expect(phasesForRun(entity)).toContain('BUILD_COMPLIANCE_STATUS')
      expect(phasesForRun(entity)).toContain('COMPLETE')
    }
  })
})

// -------------------------------------------------------------
// Handler
// -------------------------------------------------------------

describe('handler', () => {
  it('completes a manual sweep and produces a COMPLIANCE_STATUS artifact', async () => {
    await makeRegistration(firmA.id)
    const opp = await makeOpportunity(firmA.id)
    await makeActivePursuit(firmA.id, opp.id)

    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('COMPLETED')

    const artifact = await latestStatus(firmA.id)
    expect(artifact).not.toBeNull()
    expect(artifact!.artifactType).toBe('COMPLIANCE_STATUS')
  })

  it('completes with no opportunities and reports firm-level state honestly', async () => {
    await makeRegistration(firmA.id)
    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('COMPLETED')
    const data = (await latestStatus(firmA.id))!.structuredData as { totals: { opportunitiesAssessed: number } }
    expect(data.totals.opportunitiesAssessed).toBe(0)
  })

  it('records progress and a heartbeat', async () => {
    await makeRegistration(firmA.id)
    const run = await runAgent(firmA.id)
    expect(run?.progressPercent).toBeGreaterThan(0)
    expect(run?.heartbeatAt).not.toBeNull()
  })

  it('is deterministic — an unchanged surface hashes identically', async () => {
    await makeRegistration(firmA.id)
    const first = await runAgent(firmA.id)
    const second = await runAgent(firmA.id)
    expect(second?.inputHash).toBe(first?.inputHash)
  })

  it('supersedes the previous status rather than accumulating duplicates', async () => {
    await makeRegistration(firmA.id)
    await runAgent(firmA.id)
    await runAgent(firmA.id)
    const live = await prisma.agentArtifact.count({
      where: { consultingFirmId: firmA.id, artifactType: 'COMPLIANCE_STATUS', supersededByArtifactId: null },
    })
    const total = await prisma.agentArtifact.count({
      where: { consultingFirmId: firmA.id, artifactType: 'COMPLIANCE_STATUS' },
    })
    expect(live).toBe(1)
    expect(total).toBe(2)
  })

  it('isolates one bad opportunity rather than failing the tenant', async () => {
    await makeRegistration(firmA.id)
    const good = await makeOpportunity(firmA.id, { title: 'S7-COMP-QA good' })
    await makeActivePursuit(firmA.id, good.id)
    const bad = await makeOpportunity(firmA.id, { title: 'S7-COMP-QA bad' })
    await makeActivePursuit(firmA.id, bad.id)

    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('COMPLETED')
    const data = (await latestStatus(firmA.id))!.structuredData as { totals: { opportunitiesAssessed: number } }
    expect(data.totals.opportunitiesAssessed).toBe(2)
  })

  it('does not extract or notify under OBSERVE autonomy', async () => {
    await makeRegistration(firmA.id)
    const opp = await makeOpportunity(firmA.id)
    await makeActivePursuit(firmA.id, opp.id)
    const doc = await makeDocument(firmA.id, opp.id)

    const run = await runAgent(firmA.id, {
      autonomyLevel: 'OBSERVE', triggerType: 'EVENT',
      triggerEntityType: DOCUMENT_ENTITY_TYPE, triggerEntityId: doc.id,
    })
    expect(run?.status).toBe('COMPLETED')
    expect(await prisma.solicitationExtractionJob.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
    expect(run?.limitations.join(' ')).toContain('OBSERVE')
  })

  it('sweeps only actively worked pursuits, not terminal ones', async () => {
    await makeRegistration(firmA.id)
    const active = await makeOpportunity(firmA.id, { title: 'S7-COMP-QA active' })
    await makeActivePursuit(firmA.id, active.id, 'PROPOSAL')
    const closed = await makeOpportunity(firmA.id, { title: 'S7-COMP-QA closed' })
    await prisma.bidPursuit.create({
      data: { consultingFirmId: firmA.id, opportunityId: closed.id, pipelineStage: 'LOST', status: 'REVIEWING' },
    })

    await runAgent(firmA.id)
    const data = (await latestStatus(firmA.id))!.structuredData as { opportunities: Array<{ title: string }> }
    expect(data.opportunities.map((o) => o.title)).toEqual(['S7-COMP-QA active'])
  })
})

// -------------------------------------------------------------
// No provider configured
// -------------------------------------------------------------

describe('no LLM provider configured', () => {
  it('never reaches the provider boundary', async () => {
    await makeRegistration(firmA.id)
    const opp = await makeOpportunity(firmA.id)
    await makeActivePursuit(firmA.id, opp.id)
    await runAgent(firmA.id)
    expect(generateWithRouterSpy).not.toHaveBeenCalled()
  })

  it('still performs every deterministic check and produces a status', async () => {
    await makeRegistration(firmA.id, { samExpiryDate: new Date(Date.now() + 10 * DAY) })
    await prisma.certification.create({
      data: { consultingFirmId: firmA.id, name: 'S7-COMP-QA SDVOSB', category: 'SET_ASIDE', expiryDate: new Date(Date.now() + 5 * DAY), reminderLeadDays: 30 },
    })
    const opp = await makeOpportunity(firmA.id)
    await makeActivePursuit(firmA.id, opp.id)

    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('COMPLETED')

    const data = (await latestStatus(firmA.id))!.structuredData as {
      registration: { samExpiryStatus: string; certifications: unknown[] }
      llm: { aiExtractionAvailable: boolean; note: string }
    }
    expect(data.registration.samExpiryStatus).toBe('EXPIRING_SOON')
    expect(data.registration.certifications).toHaveLength(1)
    expect(data.llm.aiExtractionAvailable).toBe(false)
    expect(data.llm.note).toMatch(/AI-enhanced extraction is optional and has not run/i)
  })

  it('states the AI limitation per opportunity rather than failing', async () => {
    await makeRegistration(firmA.id)
    const opp = await makeOpportunity(firmA.id)
    await makeActivePursuit(firmA.id, opp.id)
    const run = await runAgent(firmA.id)
    expect(run?.limitations.join(' ')).toMatch(/no AI-enhanced extraction is recorded/i)
  })
})

// -------------------------------------------------------------
// Automatic extraction + duplicate prevention
// -------------------------------------------------------------

describe('automatic solicitation extraction', () => {
  it('starts the canonical §6.3A extraction when a document is added', async () => {
    await makeRegistration(firmA.id)
    const opp = await makeOpportunity(firmA.id)
    await makeActivePursuit(firmA.id, opp.id)
    const doc = await makeDocument(firmA.id, opp.id)

    const run = await runAgent(firmA.id, {
      triggerType: 'EVENT', triggerEntityType: DOCUMENT_ENTITY_TYPE, triggerEntityId: doc.id,
    })
    expect(run?.status).toBe('COMPLETED')

    const jobs = await prisma.solicitationExtractionJob.findMany({ where: { consultingFirmId: firmA.id } })
    expect(jobs).toHaveLength(1)
    expect(jobs[0].documentId).toBe(doc.id)
    expect(jobs[0].extractorVersion).toBeTruthy()
    expect(jobs[0].sourceHash).toBeTruthy()
  })

  it('creates exactly ONE extraction job for one document, even across two runs', async () => {
    await makeRegistration(firmA.id)
    const opp = await makeOpportunity(firmA.id)
    await makeActivePursuit(firmA.id, opp.id)
    const doc = await makeDocument(firmA.id, opp.id)

    const trigger = { triggerType: 'EVENT' as const, triggerEntityType: DOCUMENT_ENTITY_TYPE, triggerEntityId: doc.id }
    await runAgent(firmA.id, trigger)
    await runAgent(firmA.id, trigger)

    expect(await prisma.solicitationExtractionJob.count({ where: { consultingFirmId: firmA.id } })).toBe(1)
  })

  it('does NOT run a second extraction when the legacy pipeline already produced requirements', async () => {
    // This is the §13 duplicate-extraction rule. The legacy document extractor
    // writes MatrixRequirement rows keyed to the document; the agent defers.
    await makeRegistration(firmA.id)
    const opp = await makeOpportunity(firmA.id)
    await makeActivePursuit(firmA.id, opp.id)
    const doc = await makeDocument(firmA.id, opp.id)

    const matrix = await prisma.complianceMatrix.create({
      data: { opportunityId: opp.id, consultingFirmId: firmA.id },
    })
    await prisma.matrixRequirement.create({
      data: {
        matrixId: matrix.id, consultingFirmId: firmA.id, section: 'L.1',
        requirementText: 'Legacy AI-extracted requirement', sourceDocumentId: doc.id,
        extractionMethod: 'AI', isManuallyVerified: false, verificationStatus: 'UNVERIFIED',
      },
    })

    const run = await runAgent(firmA.id, {
      triggerType: 'EVENT', triggerEntityType: DOCUMENT_ENTITY_TYPE, triggerEntityId: doc.id,
    })

    expect(await prisma.solicitationExtractionJob.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
    expect(run?.limitations.join(' ')).toMatch(/did not run a second extraction over the same document/i)
  })

  it('does not mark extracted requirements human-verified', async () => {
    await makeRegistration(firmA.id)
    const opp = await makeOpportunity(firmA.id)
    await makeActivePursuit(firmA.id, opp.id)
    const doc = await makeDocument(firmA.id, opp.id)

    await runAgent(firmA.id, {
      triggerType: 'EVENT', triggerEntityType: DOCUMENT_ENTITY_TYPE, triggerEntityId: doc.id,
    })

    const requirements = await prisma.matrixRequirement.findMany({ where: { consultingFirmId: firmA.id } })
    expect(requirements.length).toBeGreaterThan(0)
    for (const r of requirements) {
      expect(r.isManuallyVerified, 'no extracted requirement may be auto-verified').toBe(false)
      expect(r.verificationStatus).toBe('UNVERIFIED')
    }
  })

  it('reports honestly when no readable text exists yet', async () => {
    await makeRegistration(firmA.id)
    const opp = await makeOpportunity(firmA.id, { description: '', descriptionHtml: null })
    await makeActivePursuit(firmA.id, opp.id)
    const doc = await makeDocument(firmA.id, opp.id, null)

    const run = await runAgent(firmA.id, {
      triggerType: 'EVENT', triggerEntityType: DOCUMENT_ENTITY_TYPE, triggerEntityId: doc.id,
    })
    expect(run?.status).toBe('COMPLETED')
    expect(run?.limitations.join(' ')).toMatch(/no readable text is available/i)
    expect(await prisma.solicitationExtractionJob.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it('escalates an extraction that failed at its attempt limit', async () => {
    await makeRegistration(firmA.id)
    const opp = await makeOpportunity(firmA.id)
    await makeActivePursuit(firmA.id, opp.id)
    const matrix = await prisma.complianceMatrix.create({
      data: { opportunityId: opp.id, consultingFirmId: firmA.id },
    })
    await prisma.solicitationExtractionJob.create({
      data: {
        consultingFirmId: firmA.id, opportunityId: opp.id, complianceMatrixId: matrix.id,
        idempotencyKey: uniq('failed'), status: 'FAILED', parseMethod: 'DETERMINISTIC',
        extractorVersion: 'v1', sourceHash: uniq('hash'), attempt: 3, maxAttempts: 3,
        errorMessage: 'document could not be parsed',
      },
    })

    await runAgent(firmA.id)
    const escalation = await prisma.agentEscalation.findFirst({
      where: { consultingFirmId: firmA.id, entityType: 'SolicitationExtractionJob' },
    })
    expect(escalation).not.toBeNull()
    expect(escalation!.severity).toBe('HIGH')
    expect(escalation!.reason).toContain('document could not be parsed')
  })
})

// -------------------------------------------------------------
// Human-verification protection
// -------------------------------------------------------------

describe('human-verified requirements are never overwritten', () => {
  it('leaves a verified requirement untouched when extraction reruns', async () => {
    const opp = await makeOpportunity(firmA.id)
    const first = await runExtraction({ consultingFirmId: firmA.id, opportunityId: opp.id, text: SOLICITATION_TEXT })
    expect(first.requirementsCreated).toBeGreaterThan(0)

    const target = await prisma.matrixRequirement.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })
    await prisma.matrixRequirement.update({
      where: { id: target.id },
      data: {
        isManuallyVerified: true, verificationStatus: 'VERIFIED',
        requirementText: 'HUMAN VERIFIED TEXT — must never be rewritten',
      },
    })

    await runExtraction({
      consultingFirmId: firmA.id, opportunityId: opp.id,
      text: `${SOLICITATION_TEXT}\nL.4 The offeror shall submit an additional volume.`,
      isAmendmentReprocess: true,
    })

    const after = await prisma.matrixRequirement.findUniqueOrThrow({ where: { id: target.id } })
    expect(after.requirementText).toBe('HUMAN VERIFIED TEXT — must never be rewritten')
    expect(after.isManuallyVerified).toBe(true)
    expect(after.verificationStatus).toBe('VERIFIED')
  })

  it('reports an amendment conflict instead of rewriting verified truth', async () => {
    const opp = await makeOpportunity(firmA.id)
    await runExtraction({ consultingFirmId: firmA.id, opportunityId: opp.id, text: SOLICITATION_TEXT })
    const target = await prisma.matrixRequirement.findFirstOrThrow({
      where: { consultingFirmId: firmA.id, requirementText: { contains: 'technical volume' } },
    })
    await prisma.matrixRequirement.update({
      where: { id: target.id },
      data: { isManuallyVerified: true, verificationStatus: 'VERIFIED' },
    })

    // An amendment that removes the requirement the human verified.
    await recordAmendmentRevision({
      consultingFirmId: firmA.id,
      opportunityId: opp.id,
      text: SOLICITATION_TEXT.replace('L.1 The offeror shall submit a technical volume not exceeding 30 pages.', ''),
    })

    const result = await recheckAmendmentCompliance({ consultingFirmId: firmA.id, opportunityId: opp.id })

    const preserved = await prisma.matrixRequirement.findUniqueOrThrow({ where: { id: target.id } })
    expect(preserved.isManuallyVerified).toBe(true)
    expect(preserved.requirementText).toBe(target.requirementText)
    expect(result.humanReviewRequired).toBe(true)
  })

  it('never clears legalReviewRequired on a clause', async () => {
    await makeRegistration(firmA.id)
    const opp = await makeOpportunity(firmA.id)
    await makeActivePursuit(firmA.id, opp.id)
    await runExtraction({ consultingFirmId: firmA.id, opportunityId: opp.id, text: SOLICITATION_TEXT })

    const before = await prisma.clauseObligation.findMany({ where: { consultingFirmId: firmA.id } })
    expect(before.length).toBeGreaterThan(0)
    expect(before.some((c) => c.legalReviewRequired)).toBe(true)

    await runAgent(firmA.id)

    const after = await prisma.clauseObligation.findMany({ where: { consultingFirmId: firmA.id } })
    for (const clause of after) {
      const original = before.find((c) => c.id === clause.id)!
      expect(clause.legalReviewRequired).toBe(original.legalReviewRequired)
      expect(clause.isManuallyVerified).toBe(original.isManuallyVerified)
      expect(clause.applicability).toBe(original.applicability)
    }
  })

  it('surfaces unresolved flow-downs as human review, never as resolved', async () => {
    await makeRegistration(firmA.id)
    const opp = await makeOpportunity(firmA.id)
    await makeActivePursuit(firmA.id, opp.id)
    await runExtraction({ consultingFirmId: firmA.id, opportunityId: opp.id, text: SOLICITATION_TEXT })

    await runAgent(firmA.id)
    const data = (await latestStatus(firmA.id))!.structuredData as {
      opportunities: Array<{ clauses: { unresolvedFlowDowns: number }; statusReasons: string[] }>
    }
    const row = data.opportunities[0]
    expect(row.clauses.unresolvedFlowDowns).toBeGreaterThan(0)
    expect(row.statusReasons.join(' ')).toContain('legal review required')
  })
})

// -------------------------------------------------------------
// Registration / certification / insurance / bonding boundaries
// -------------------------------------------------------------

describe('registration watch', () => {
  it('reports an active SAM registration with plenty of runway', async () => {
    await makeRegistration(firmA.id, { samExpiryDate: new Date(Date.now() + 200 * DAY) })
    const result = await assessRegistration(firmA.id)
    expect(result.sam.expiryStatus).toBe('ACTIVE')
    expect(result.sam.withinEscalationWindow).toBe(false)
    expect(result.escalations).toHaveLength(0)
  })

  it('does not escalate SAM expiry just outside the 30-day window', async () => {
    await makeRegistration(firmA.id, { samExpiryDate: new Date(Date.now() + 31 * DAY) })
    const result = await assessRegistration(firmA.id)
    expect(result.sam.withinEscalationWindow).toBe(false)
  })

  it('escalates SAM expiry exactly AT the 30-day window', async () => {
    await makeRegistration(firmA.id, { samExpiryDate: new Date(Date.now() + SAM_EXPIRY_ESCALATION_DAYS * DAY) })
    const result = await assessRegistration(firmA.id)
    expect(result.sam.withinEscalationWindow).toBe(true)
    expect(result.escalations.some((e) => e.title.includes('SAM registration expires'))).toBe(true)
  })

  it('escalates SAM expiry inside the window', async () => {
    await makeRegistration(firmA.id, { samExpiryDate: new Date(Date.now() + 10 * DAY) })
    const result = await assessRegistration(firmA.id)
    expect(result.sam.withinEscalationWindow).toBe(true)
  })

  it('treats an expired SAM registration as a blocker', async () => {
    await makeRegistration(firmA.id, { samExpiryDate: new Date(Date.now() - DAY) })
    const result = await assessRegistration(firmA.id)
    expect(result.sam.expiryStatus).toBe('EXPIRED')
    expect(result.blockers.join(' ')).toMatch(/SAM registration expired/i)
    expect(result.escalations.some((e) => e.severity === 'CRITICAL')).toBe(true)
  })

  it('reports a missing registration profile as insufficient data, not as compliant', async () => {
    const result = await assessRegistration(firmA.id)
    expect(result.sam.missing).toBe(true)
    expect(result.insufficient.join(' ')).toMatch(/No registration profile is recorded/i)
    expect(result.blockers).toHaveLength(0)
  })

  it('states the SAM data freshness rather than implying a live lookup', async () => {
    await makeRegistration(firmA.id)
    const result = await assessRegistration(firmA.id)
    expect(result.sam.dataFreshness).toMatch(/No live SAM\.gov lookup was performed/i)
  })
})

describe('certification watch', () => {
  const makeCert = (over: Partial<Prisma.CertificationUncheckedCreateInput> = {}) =>
    prisma.certification.create({
      data: {
        consultingFirmId: firmA.id, name: uniq('S7-COMP-QA cert'), category: 'SET_ASIDE',
        reminderLeadDays: 30, ...over,
      },
    })

  it('treats a certification with runway as active', async () => {
    await makeCert({ expiryDate: new Date(Date.now() + 90 * DAY) })
    const result = await assessRegistration(firmA.id)
    expect(result.certifications[0].expiryStatus).toBe('ACTIVE')
  })

  it('honours the record\'s own reminderLeadDays, not a global rule', async () => {
    await makeCert({ expiryDate: new Date(Date.now() + 20 * DAY), reminderLeadDays: 30 })
    await makeCert({ expiryDate: new Date(Date.now() + 20 * DAY), reminderLeadDays: 5 })
    const result = await assessRegistration(firmA.id)
    const statuses = result.certifications.map((c) => c.expiryStatus).sort()
    expect(statuses).toEqual(['ACTIVE', 'EXPIRING_SOON'])
  })

  it('treats an expired certification as expired, never as valid', async () => {
    await makeCert({ expiryDate: new Date(Date.now() - DAY) })
    const result = await assessRegistration(firmA.id)
    expect(result.certifications[0].expiryStatus).toBe('EXPIRED')
    expect(result.escalations.some((e) => e.title.includes('Certification expired'))).toBe(true)
  })

  it('blocks an opportunity whose certification expires before its deadline', async () => {
    await makeRegistration(firmA.id)
    await makeCert({ name: 'S7-COMP-QA SDVOSB', expiryDate: new Date(Date.now() + 10 * DAY) })
    const opp = await makeOpportunity(firmA.id, { responseDeadline: new Date(Date.now() + 30 * DAY) })
    await makeActivePursuit(firmA.id, opp.id)

    await runAgent(firmA.id)
    const data = (await latestStatus(firmA.id))!.structuredData as {
      opportunities: Array<{ overallStatus: string; certificationWarnings: string[] }>
    }
    expect(data.opportunities[0].certificationWarnings.length).toBeGreaterThan(0)
    expect(data.opportunities[0].overallStatus).toBe('BLOCKED')
  })

  it('does not block when the certification outlives the deadline', async () => {
    await makeRegistration(firmA.id)
    await makeCert({ expiryDate: new Date(Date.now() + 200 * DAY) })
    const opp = await makeOpportunity(firmA.id, { responseDeadline: new Date(Date.now() + 30 * DAY) })
    await makeActivePursuit(firmA.id, opp.id)

    await runAgent(firmA.id)
    const data = (await latestStatus(firmA.id))!.structuredData as {
      opportunities: Array<{ certificationWarnings: string[] }>
    }
    expect(data.opportunities[0].certificationWarnings).toHaveLength(0)
  })

  it('never renews or changes a certification', async () => {
    const cert = await makeCert({ expiryDate: new Date(Date.now() - DAY) })
    await makeRegistration(firmA.id)
    await runAgent(firmA.id)
    const after = await prisma.certification.findUniqueOrThrow({ where: { id: cert.id } })
    expect(after.expiryDate?.getTime()).toBe(cert.expiryDate?.getTime())
    expect(after.isArchived).toBe(false)
  })
})

describe('insurance watch', () => {
  const makePolicy = (over: Partial<Prisma.InsurancePolicyUncheckedCreateInput> = {}) =>
    prisma.insurancePolicy.create({
      data: { consultingFirmId: firmA.id, policyType: 'GENERAL_LIABILITY', reminderLeadDays: 30, ...over },
    })

  it('classifies a valid policy', async () => {
    await makePolicy({ expiryDate: new Date(Date.now() + 90 * DAY) })
    const result = await assessRegistration(firmA.id)
    expect(result.insurance[0].expiryStatus).toBe('ACTIVE')
  })

  it('classifies an expiring policy', async () => {
    await makePolicy({ expiryDate: new Date(Date.now() + 10 * DAY) })
    const result = await assessRegistration(firmA.id)
    expect(result.insurance[0].expiryStatus).toBe('EXPIRING_SOON')
  })

  it('classifies and escalates an expired policy', async () => {
    await makePolicy({ expiryDate: new Date(Date.now() - DAY) })
    const result = await assessRegistration(firmA.id)
    expect(result.insurance[0].expiryStatus).toBe('EXPIRED')
    expect(result.escalations.some((e) => e.title.includes('Insurance expired'))).toBe(true)
  })

  it('reports missing insurance without inferring a required coverage type', async () => {
    const result = await assessRegistration(firmA.id)
    expect(result.insurance).toHaveLength(0)
    const message = result.insufficient.join(' ')
    expect(message).toMatch(/No insurance policies are recorded/i)
    expect(message).toMatch(/cannot be assessed from platform data alone/i)
  })

  it('never changes an insurance record', async () => {
    const policy = await makePolicy({ expiryDate: new Date(Date.now() - DAY) })
    await makeRegistration(firmA.id)
    await runAgent(firmA.id)
    const after = await prisma.insurancePolicy.findUniqueOrThrow({ where: { id: policy.id } })
    expect(after.expiryDate?.getTime()).toBe(policy.expiryDate?.getTime())
  })
})

describe('bonding capacity', () => {
  const D = (v: string) => new Prisma.Decimal(v)

  it('reports MISSING when nothing is recorded', () => {
    const result = assessBonding(null)
    expect(result.state).toBe('MISSING')
    expect(result.availableCapacity).toBeNull()
    expect(result.reasons.join(' ')).toMatch(/No surety bonding capacity is recorded/i)
  })

  it('derives headroom with Decimal arithmetic', async () => {
    const row = await prisma.bondingCapacity.create({
      data: {
        consultingFirmId: firmA.id, suretyName: 'S7-COMP-QA Surety',
        aggregateLimit: D('10000000.00'), committedAmount: D('3500000.55'),
        singleProjectLimit: D('4000000.00'), expiryDate: new Date(Date.now() + 200 * DAY),
      },
    })
    const result = assessBonding(row)
    expect(result.state).toBe('SUFFICIENT')
    // Exact to the cent — never a float.
    expect(result.availableCapacity).toBe('6499999.45')
    expect(result.aggregateLimit).toBe('10000000.00')
    expect(result.singleProjectLimit).toBe('4000000.00')
  })

  it('reports INSUFFICIENT when fully committed', async () => {
    const row = await prisma.bondingCapacity.create({
      data: { consultingFirmId: firmA.id, aggregateLimit: D('5000000.00'), committedAmount: D('5000000.00') },
    })
    const result = assessBonding(row)
    expect(result.state).toBe('INSUFFICIENT')
    expect(result.availableCapacity).toBe('0.00')
  })

  it('reports EXPIRED and never counts expired capacity as available', async () => {
    const row = await prisma.bondingCapacity.create({
      data: {
        consultingFirmId: firmA.id, aggregateLimit: D('5000000.00'), committedAmount: D('1000000.00'),
        expiryDate: new Date(Date.now() - DAY),
      },
    })
    const result = assessBonding(row)
    expect(result.state).toBe('EXPIRED')
  })

  it('reports INSUFFICIENT_DATA rather than assuming zero committed', async () => {
    const row = await prisma.bondingCapacity.create({
      data: { consultingFirmId: firmA.id, aggregateLimit: D('5000000.00') },
    })
    const result = assessBonding(row)
    expect(result.state).toBe('INSUFFICIENT_DATA')
    expect(result.availableCapacity).toBeNull()
    expect(result.reasons.join(' ')).toMatch(/No committed amount is recorded/i)
  })

  it('reports INSUFFICIENT_DATA when no aggregate limit exists', async () => {
    const row = await prisma.bondingCapacity.create({
      data: { consultingFirmId: firmA.id, committedAmount: D('100000.00') },
    })
    const result = assessBonding(row)
    expect(result.state).toBe('INSUFFICIENT_DATA')
    expect(result.reasons.join(' ')).toMatch(/No aggregate bonding limit is recorded/i)
  })

  it('keeps the single-project limit distinct from the aggregate', async () => {
    const row = await prisma.bondingCapacity.create({
      data: {
        consultingFirmId: firmA.id, singleProjectLimit: D('2000000.00'),
        aggregateLimit: D('8000000.00'), committedAmount: D('1000000.00'),
      },
    })
    const result = assessBonding(row)
    expect(result.singleProjectLimit).toBe('2000000.00')
    expect(result.aggregateLimit).toBe('8000000.00')
    expect(result.availableCapacity).toBe('7000000.00')
  })

  it('never lets the agent write a bonding record', async () => {
    await makeRegistration(firmA.id)
    const row = await prisma.bondingCapacity.create({
      data: { consultingFirmId: firmA.id, aggregateLimit: D('1000000.00'), committedAmount: D('0.00') },
    })
    await runAgent(firmA.id)
    const after = await prisma.bondingCapacity.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.aggregateLimit?.toFixed(2)).toBe('1000000.00')
    expect(after.committedAmount?.toFixed(2)).toBe('0.00')
    expect(after.status).toBe('ACTIVE')
    expect(await prisma.bondingCapacity.count({ where: { consultingFirmId: firmA.id } })).toBe(1)
  })
})

// -------------------------------------------------------------
// Overall status
// -------------------------------------------------------------

describe('overall status is deterministic', () => {
  it('reports COMPLIANT_CURRENT only when nothing is wrong', () => {
    const r = deriveOverallStatus({ blockers: [], humanReviewReasons: [], attentionReasons: [], insufficientReasons: [] })
    expect(r.status).toBe('COMPLIANT_CURRENT')
  })

  it('ranks BLOCKED above every other condition', () => {
    const r = deriveOverallStatus({
      blockers: ['SAM expired'], humanReviewReasons: ['ambiguous mapping'],
      attentionReasons: ['cert expiring'], insufficientReasons: ['no data'],
    })
    expect(r.status).toBe('BLOCKED')
    expect(r.reasons).toEqual(['SAM expired'])
  })

  it('ranks HUMAN_REVIEW_REQUIRED above attention', () => {
    const r = deriveOverallStatus({
      blockers: [], humanReviewReasons: ['flow-down'], attentionReasons: ['expiring'], insufficientReasons: [],
    })
    expect(r.status).toBe('HUMAN_REVIEW_REQUIRED')
  })

  it('reports INSUFFICIENT_DATA rather than COMPLIANT when records are absent', () => {
    const r = deriveOverallStatus({
      blockers: [], humanReviewReasons: [], attentionReasons: [], insufficientReasons: ['no registration'],
    })
    expect(r.status).toBe('INSUFFICIENT_DATA')
  })

  it('ranks INSUFFICIENT_DATA below a real problem but above compliant', () => {
    expect(worstStatus(['COMPLIANT_CURRENT', 'INSUFFICIENT_DATA'])).toBe('INSUFFICIENT_DATA')
    expect(worstStatus(['INSUFFICIENT_DATA', 'ATTENTION_REQUIRED'])).toBe('ATTENTION_REQUIRED')
    expect(worstStatus(['HUMAN_REVIEW_REQUIRED', 'BLOCKED'])).toBe('BLOCKED')
  })

  it('never calls a firm COMPLIANT merely because extraction finished', async () => {
    // No registration profile at all, but a completed extraction.
    const opp = await makeOpportunity(firmA.id)
    await makeActivePursuit(firmA.id, opp.id)
    await runExtraction({ consultingFirmId: firmA.id, opportunityId: opp.id, text: SOLICITATION_TEXT })

    await runAgent(firmA.id)
    const data = (await latestStatus(firmA.id))!.structuredData as { overallStatus: string }
    expect(data.overallStatus).not.toBe('COMPLIANT_CURRENT')
  })
})

// -------------------------------------------------------------
// Amendment re-check
// -------------------------------------------------------------

describe('amendment re-check', () => {
  it('reports no amendment honestly', async () => {
    const opp = await makeOpportunity(firmA.id)
    const result = await recheckAmendmentCompliance({ consultingFirmId: firmA.id, opportunityId: opp.id })
    expect(result.latestRevisionId).toBeNull()
    expect(result.dataLimitations.join(' ')).toMatch(/No amendment revision exists/i)
  })

  it('reads the canonical §6.4B diff rather than recomputing it', async () => {
    const opp = await makeOpportunity(firmA.id)
    await recordAmendmentRevision({ consultingFirmId: firmA.id, opportunityId: opp.id, text: SOLICITATION_TEXT })
    const result = await recheckAmendmentCompliance({ consultingFirmId: firmA.id, opportunityId: opp.id })

    expect(result.latestRevisionNo).toBe(1)
    expect(result.changedRequirements).toBeGreaterThan(0)
    expect(result.changedClauses).toBeGreaterThan(0)
    expect(result.humanReviewRequired).toBe(true)
  })

  it('stamps the canonical prompt version, never one of its own', async () => {
    const opp = await makeOpportunity(firmA.id)
    await recordAmendmentRevision({ consultingFirmId: firmA.id, opportunityId: opp.id, text: SOLICITATION_TEXT })
    const result = await recheckAmendmentCompliance({ consultingFirmId: firmA.id, opportunityId: opp.id })
    expect(result.promptVersion).toBe('section6-amendment-v1')
  })

  it('says plainly when no AI summary contributed', async () => {
    const opp = await makeOpportunity(firmA.id)
    await recordAmendmentRevision({ consultingFirmId: firmA.id, opportunityId: opp.id, text: SOLICITATION_TEXT })
    const result = await recheckAmendmentCompliance({ consultingFirmId: firmA.id, opportunityId: opp.id })
    expect(result.analysisBasis).toMatch(/Deterministic §6\.4B comparison only/i)
  })

  it('escalates an amendment inside five working days of the deadline', async () => {
    // 3 calendar days out spans a weekend in most weeks, so this is inside the
    // 5-WORKING-day window however the days fall.
    const opp = await makeOpportunity(firmA.id, { responseDeadline: new Date(Date.now() + 3 * DAY) })
    await recordAmendmentRevision({ consultingFirmId: firmA.id, opportunityId: opp.id, text: SOLICITATION_TEXT })

    const result = await recheckAmendmentCompliance({ consultingFirmId: firmA.id, opportunityId: opp.id })
    expect(result.withinDeadlineWindow).toBe(true)
    expect(result.escalations.some((e) => e.title.includes('working day'))).toBe(true)
    expect(result.escalations[0].reason).toContain('weekends and US federal holidays excluded')
  })

  it('does not escalate an amendment far from the deadline', async () => {
    const opp = await makeOpportunity(firmA.id, { responseDeadline: new Date(Date.now() + 120 * DAY) })
    await recordAmendmentRevision({ consultingFirmId: firmA.id, opportunityId: opp.id, text: SOLICITATION_TEXT })
    const result = await recheckAmendmentCompliance({ consultingFirmId: firmA.id, opportunityId: opp.id })
    expect(result.withinDeadlineWindow).toBe(false)
  })

  it('does not create duplicate impacts when re-checked twice', async () => {
    const opp = await makeOpportunity(firmA.id)
    await recordAmendmentRevision({ consultingFirmId: firmA.id, opportunityId: opp.id, text: SOLICITATION_TEXT })
    const before = await prisma.amendmentImpact.count({ where: { consultingFirmId: firmA.id } })

    await recheckAmendmentCompliance({ consultingFirmId: firmA.id, opportunityId: opp.id })
    await recheckAmendmentCompliance({ consultingFirmId: firmA.id, opportunityId: opp.id })

    expect(await prisma.amendmentImpact.count({ where: { consultingFirmId: firmA.id } })).toBe(before)
  })

  it('never acknowledges an amendment on the human\'s behalf', async () => {
    await makeRegistration(firmA.id)
    const opp = await makeOpportunity(firmA.id)
    await makeActivePursuit(firmA.id, opp.id)
    const recorded = await recordAmendmentRevision({ consultingFirmId: firmA.id, opportunityId: opp.id, text: SOLICITATION_TEXT })

    await runAgent(firmA.id, {
      triggerType: 'EVENT', triggerEntityType: AMENDMENT_ENTITY_TYPE, triggerEntityId: recorded.revisionId!,
    })

    const revision = await prisma.amendmentRevision.findUniqueOrThrow({ where: { id: recorded.revisionId! } })
    expect(revision.acknowledgedAt).toBeNull()
    expect(revision.acknowledgedByUserId).toBeNull()
    expect(revision.humanReviewRequired).toBe(true)
    expect(await prisma.amendmentImpact.count({
      where: { consultingFirmId: firmA.id, acknowledgedAt: { not: null } },
    })).toBe(0)
  })
})

// -------------------------------------------------------------
// Human control
// -------------------------------------------------------------

describe('human control is never bypassed', () => {
  const AUTONOMY = ['PROPOSE', 'ACT_WITH_GUARDRAILS'] as const

  it.each(AUTONOMY)('at %s, never marks a requirement human-verified', async (autonomyLevel) => {
    await makeRegistration(firmA.id)
    const opp = await makeOpportunity(firmA.id)
    await makeActivePursuit(firmA.id, opp.id)
    await runExtraction({ consultingFirmId: firmA.id, opportunityId: opp.id, text: SOLICITATION_TEXT })

    await runAgent(firmA.id, { autonomyLevel })

    const verified = await prisma.matrixRequirement.count({
      where: { consultingFirmId: firmA.id, isManuallyVerified: true },
    })
    expect(verified).toBe(0)
  })

  it.each(AUTONOMY)('at %s, never clears legal review on a clause', async (autonomyLevel) => {
    await makeRegistration(firmA.id)
    const opp = await makeOpportunity(firmA.id)
    await makeActivePursuit(firmA.id, opp.id)
    await runExtraction({ consultingFirmId: firmA.id, opportunityId: opp.id, text: SOLICITATION_TEXT })

    await runAgent(firmA.id, { autonomyLevel })

    const cleared = await prisma.clauseObligation.count({
      where: { consultingFirmId: firmA.id, legalReviewRequired: false, flowDownStatus: { not: 'NO_EXPLICIT_FLOWDOWN_FOUND' } },
    })
    expect(cleared).toBe(0)
  })

  it.each(AUTONOMY)('at %s, never confirms an unverified L/M mapping', async (autonomyLevel) => {
    await makeRegistration(firmA.id)
    const opp = await makeOpportunity(firmA.id)
    await makeActivePursuit(firmA.id, opp.id)
    await runExtraction({ consultingFirmId: firmA.id, opportunityId: opp.id, text: SOLICITATION_TEXT })

    await runAgent(firmA.id, { autonomyLevel })

    const confirmed = await prisma.sectionLmMapping.count({
      where: { consultingFirmId: firmA.id, verification: 'CONFIRMED' },
    })
    expect(confirmed).toBe(0)
  })

  it.each(AUTONOMY)('at %s, never changes registration truth', async (autonomyLevel) => {
    const profile = await makeRegistration(firmA.id, { samStatus: 'INACTIVE' })
    await runAgent(firmA.id, { autonomyLevel })
    const after = await prisma.registrationProfile.findUniqueOrThrow({ where: { consultingFirmId: firmA.id } })
    expect(after.samStatus).toBe('INACTIVE')
    expect(after.samExpiryDate?.getTime()).toBe(profile.samExpiryDate?.getTime())
  })

  it.each(AUTONOMY)('at %s, never records a bid decision', async (autonomyLevel) => {
    await makeRegistration(firmA.id)
    const opp = await makeOpportunity(firmA.id)
    await makeActivePursuit(firmA.id, opp.id)
    await runAgent(firmA.id, { autonomyLevel })
    expect(await prisma.bidDecision.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it.each(AUTONOMY)('at %s, never writes a submission validation pass', async (autonomyLevel) => {
    await makeRegistration(firmA.id)
    const opp = await makeOpportunity(firmA.id)
    await makeActivePursuit(firmA.id, opp.id)
    await runAgent(firmA.id, { autonomyLevel })
    expect(await prisma.submissionValidationCheck.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })
})

// -------------------------------------------------------------
// Escalation dedupe
// -------------------------------------------------------------

describe('escalations', () => {
  it('does not duplicate a SAM escalation across runs', async () => {
    await makeRegistration(firmA.id, { samExpiryDate: new Date(Date.now() + 10 * DAY) })
    await runAgent(firmA.id)
    await runAgent(firmA.id)
    const count = await prisma.agentEscalation.count({
      where: { consultingFirmId: firmA.id, entityType: 'RegistrationProfile' },
    })
    expect(count).toBe(1)
  })

  it('does not reopen an escalation a human resolved', async () => {
    await makeRegistration(firmA.id, { samExpiryDate: new Date(Date.now() + 10 * DAY) })
    await runAgent(firmA.id)
    const escalation = await prisma.agentEscalation.findFirstOrThrow({
      where: { consultingFirmId: firmA.id, entityType: 'RegistrationProfile' },
    })
    await prisma.agentEscalation.update({
      where: { id: escalation.id },
      data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedByUserId: adminA.id },
    })
    await runAgent(firmA.id)
    const after = await prisma.agentEscalation.findUniqueOrThrow({ where: { id: escalation.id } })
    expect(after.status).toBe('RESOLVED')
  })

  it('raises ONE firm-level overall escalation however the run was triggered', async () => {
    // Regression: the overall-status escalation is about the FIRM, so a
    // scheduled sweep and an entity-triggered run must refresh one item rather
    // than each opening their own copy.
    await makeRegistration(firmA.id, { samExpiryDate: new Date(Date.now() - DAY) })
    const opp = await makeOpportunity(firmA.id)
    await makeActivePursuit(firmA.id, opp.id)

    await runAgent(firmA.id)
    await runAgent(firmA.id, { triggerType: 'EVENT', triggerEntityType: 'Opportunity', triggerEntityId: opp.id })
    await runAgent(firmA.id)

    const overall = await prisma.agentEscalation.findMany({
      where: { consultingFirmId: firmA.id, agentKey: AGENT, entityType: 'ConsultingFirm' },
    })
    expect(overall).toHaveLength(1)
  })

  it('does not escalate for every warning', async () => {
    // A healthy firm with one merely-expiring insurance policy produces
    // attention, not an escalation.
    await makeRegistration(firmA.id)
    await prisma.insurancePolicy.create({
      data: { consultingFirmId: firmA.id, policyType: 'CYBER', expiryDate: new Date(Date.now() + 10 * DAY), reminderLeadDays: 30 },
    })
    const result = await assessRegistration(firmA.id)
    expect(result.attention.length).toBeGreaterThan(0)
    expect(result.escalations).toHaveLength(0)
  })
})

// -------------------------------------------------------------
// Tenant isolation
// -------------------------------------------------------------

describe('tenant isolation', () => {
  it('never reads another firm\'s registration', async () => {
    await makeRegistration(firmB.id, { samStatus: 'INACTIVE', uei: 'FIRMBUEI0001' })
    const result = await assessRegistration(firmA.id)
    expect(result.sam.missing).toBe(true)
  })

  it('never reads another firm\'s bonding capacity', async () => {
    await prisma.bondingCapacity.create({
      data: { consultingFirmId: firmB.id, aggregateLimit: new Prisma.Decimal('9999999.00'), committedAmount: new Prisma.Decimal('0.00') },
    })
    const result = await assessRegistration(firmA.id)
    expect(result.bonding.state).toBe('MISSING')
  })

  it('refuses to run against another firm\'s opportunity', async () => {
    await makeRegistration(firmA.id)
    const oppB = await makeOpportunity(firmB.id, { title: 'S7-COMP-QA firm B only' })
    await makeActivePursuit(firmB.id, oppB.id)

    const run = await runAgent(firmA.id, {
      triggerType: 'EVENT', triggerEntityType: 'Opportunity', triggerEntityId: oppB.id,
    })
    expect(run?.status).toBe('COMPLETED')
    const artifact = await latestStatus(firmA.id)
    expect(JSON.stringify(artifact!.structuredData)).not.toContain('firm B only')
  })

  it('never reads another firm\'s extraction job through an event', async () => {
    await makeRegistration(firmA.id)
    const oppB = await makeOpportunity(firmB.id)
    const jobB = await runExtraction({ consultingFirmId: firmB.id, opportunityId: oppB.id, text: SOLICITATION_TEXT })

    const run = await runAgent(firmA.id, {
      triggerType: 'EVENT', triggerEntityType: EXTRACTION_JOB_ENTITY_TYPE, triggerEntityId: jobB.jobId,
    })
    expect(run?.status).toBe('COMPLETED')
    const data = (await latestStatus(firmA.id))!.structuredData as { totals: { opportunitiesAssessed: number } }
    expect(data.totals.opportunitiesAssessed).toBe(0)
  })

  it('never reads another firm\'s amendment through an event', async () => {
    await makeRegistration(firmA.id)
    const oppB = await makeOpportunity(firmB.id)
    const revB = await recordAmendmentRevision({ consultingFirmId: firmB.id, opportunityId: oppB.id, text: SOLICITATION_TEXT })

    const run = await runAgent(firmA.id, {
      triggerType: 'EVENT', triggerEntityType: AMENDMENT_ENTITY_TYPE, triggerEntityId: revB.revisionId!,
    })
    expect(run?.status).toBe('COMPLETED')
    const data = (await latestStatus(firmA.id))!.structuredData as { totals: { opportunitiesAssessed: number } }
    expect(data.totals.opportunitiesAssessed).toBe(0)
  })

  it('never raises an escalation against another firm', async () => {
    await makeRegistration(firmB.id, { samExpiryDate: new Date(Date.now() - DAY) })
    await makeRegistration(firmA.id)
    await runAgent(firmA.id)
    expect(await prisma.agentEscalation.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
  })

  it('never includes another firm\'s amendment re-check', async () => {
    const oppB = await makeOpportunity(firmB.id)
    await recordAmendmentRevision({ consultingFirmId: firmB.id, opportunityId: oppB.id, text: SOLICITATION_TEXT })
    const result = await recheckAmendmentCompliance({ consultingFirmId: firmA.id, opportunityId: oppB.id })
    expect(result.latestRevisionId).toBeNull()
  })
})
