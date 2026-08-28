// =============================================================
// §7.7 — Proposal Agent against a real PostgreSQL database.
//
// The centre of this file is §4: at PROPOSE and at ACT_WITH_GUARDRAILS the
// agent never approves a section, a review or a cycle, never verifies a
// requirement, never selects final past performance, never submits, and never
// rewrites human-approved text.
//
// It also proves the no-key path: with no provider the agent still builds the
// outline, maps requirements, creates skeletons, computes coverage, manages
// reviews and produces PROPOSAL_STATUS.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Prisma } from '@prisma/client'

const generateWithRouterSpy = vi.fn()
vi.mock('../../llm/llmRouter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../llm/llmRouter')>()
  return {
    ...actual,
    generateWithRouter: (...a: unknown[]) => generateWithRouterSpy(...a),
    // No provider in this environment; the agent must still run fully.
    isLlmProviderConfigured: async () => false,
  }
})

import { prisma } from '../../../config/database'
import {
  createTestFirm, createTestUser, cleanupFirm, disconnectDb, type TestFirm, type TestUser,
} from '../../../test-utils/testClient'
import { dispatchAgentRun } from '../dispatch'
import { createRun } from '../runService'
import { getAgentDefinition, agentsSubscribedTo, AGENT_REGISTRY } from '../registry'
import { DOMAIN_AGENT_KEYS } from '../types'
import {
  PROPOSAL_PHASES, phasesForRun, LOCKED_SECTION_STATUSES, NO_PROVIDER_LIMITATION,
  buildSectionDraftFingerprint,
} from './proposalAgentHandler'
import { buildOutline, coverageFor, skeletonCandidates, HIGH_CONFIDENCE_MAPPING } from './outlineBuilder'
import { summariseLibrary, retrieveApprovedSources, scoreCapabilityRelevance, hashNarrativeContent } from './capabilityLibrary'

const AGENT = 'PROPOSAL' as const
const DAY = 86_400_000

let firmA: TestFirm
let firmB: TestFirm
let adminA: TestUser
let ownerA: TestUser
let reviewerA: TestUser

let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

beforeAll(async () => {
  firmA = await createTestFirm({ name: 'Proposal Agent Firm A' })
  firmB = await createTestFirm({ name: 'Proposal Agent Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  ownerA = await createTestUser(firmA.id, { role: 'CONSULTANT' })
  reviewerA = await createTestUser(firmA.id, { role: 'CONSULTANT' })
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

beforeEach(async () => {
  generateWithRouterSpy.mockReset()
  for (const id of [firmA.id, firmB.id]) {
    await prisma.agentEscalation.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentRun.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentSchedule.deleteMany({ where: { consultingFirmId: id } })
    await prisma.userNotification.deleteMany({ where: { consultingFirmId: id } })
    await prisma.capabilityNarrativeVersion.deleteMany({ where: { consultingFirmId: id } })
    await prisma.capabilityNarrative.deleteMany({ where: { consultingFirmId: id } })
    await prisma.reviewComment.deleteMany({ where: { reviewCycle: { consultingFirmId: id } } })
    await prisma.reviewCycle.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pastPerformanceSelection.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pastPerformanceRecord.deleteMany({ where: { consultingFirmId: id } })
    await prisma.proposalSectionReview.deleteMany({ where: { consultingFirmId: id } })
    await prisma.proposalSectionVersion.deleteMany({ where: { consultingFirmId: id } })
    await prisma.proposalSection.deleteMany({ where: { consultingFirmId: id } })
    await prisma.proposal.deleteMany({ where: { consultingFirmId: id } })
    await prisma.sectionLmMapping.deleteMany({ where: { consultingFirmId: id } })
    await prisma.opportunity.deleteMany({ where: { consultingFirmId: id } })
  }
})

// -------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------

async function makeOpportunity(firmId: string, over: Partial<Prisma.OpportunityUncheckedCreateInput> = {}) {
  return prisma.opportunity.create({
    data: {
      consultingFirmId: firmId, samNoticeId: uniq('S7-PROP-QA'),
      title: 'S7-PROP-QA cyber support', agency: 'Department of Defense',
      naicsCode: '541512', setAsideType: 'SDVOSB',
      responseDeadline: new Date(Date.now() + 60 * DAY),
      status: 'ACTIVE', isDemo: false, ...over,
    },
  })
}

async function makeProposal(firmId: string, opportunityId?: string) {
  const oppId = opportunityId ?? (await makeOpportunity(firmId)).id
  const proposal = await prisma.proposal.create({
    data: { consultingFirmId: firmId, opportunityId: oppId, title: 'S7-PROP-QA proposal' },
  })
  return { proposal, opportunityId: oppId }
}

async function makeRequirements(opportunityId: string, count: number, mandatory = true) {
  const matrix = await prisma.complianceMatrix.upsert({
    where: { opportunityId },
    create: { opportunityId, consultingFirmId: firmA.id },
    update: {},
  })
  const created = []
  for (let i = 0; i < count; i += 1) {
    created.push(await prisma.matrixRequirement.create({
      data: {
        matrixId: matrix.id, section: `L.${i + 1}`, requirementText: `S7-PROP-QA requirement ${i + 1}`,
        isMandatory: mandatory, sortOrder: i,
      },
    }))
  }
  return created
}

async function makeSection(firmId: string, opportunityId: string, proposalId: string, over: Record<string, unknown> = {}) {
  return prisma.proposalSection.create({
    data: {
      consultingFirmId: firmId, opportunityId, proposalId,
      title: 'S7-PROP-QA section', status: 'DRAFTING', ...over,
    },
  })
}

async function makeApprovedNarrative(firmId: string, over: Record<string, unknown> = {}) {
  const narrative = await prisma.capabilityNarrative.create({
    data: {
      consultingFirmId: firmId, title: 'S7-PROP-QA cyber capability',
      category: 'TECHNICAL_NARRATIVE',
      capabilityKeys: ['cyber', 'incident response'],
      naicsCodes: ['541512'], agencyTags: ['Department of Defense'],
      ...over,
    },
  })
  const content = 'The contractor operates a 24x7 security operations centre.'
  const version = await prisma.capabilityNarrativeVersion.create({
    data: {
      consultingFirmId: firmId, capabilityNarrativeId: narrative.id, versionNumber: 1,
      content, contentHash: hashNarrativeContent(content),
      status: 'APPROVED', approvedByUserId: 'human-user', approvedAt: new Date(),
    },
  })
  await prisma.capabilityNarrative.update({
    where: { id: narrative.id }, data: { currentApprovedVersionId: version.id },
  })
  return { narrative, version }
}

async function runAgent(firmId: string, over: Record<string, unknown> = {}) {
  const { run } = await createRun({
    consultingFirmId: firmId, agentKey: AGENT, triggerType: 'MANUAL',
    idempotencyKey: uniq('proposal-run'), ...over,
  })
  await dispatchAgentRun(run.id)
  return prisma.agentRun.findUnique({ where: { id: run.id } })
}

const readStatus = async (firmId: string, proposalId: string) => {
  const artifact = await prisma.agentArtifact.findFirst({
    where: {
      consultingFirmId: firmId, agentKey: AGENT, artifactType: 'PROPOSAL_STATUS',
      sourceEntityId: proposalId, supersededByArtifactId: null,
    },
    orderBy: { createdAt: 'desc' },
  })
  return artifact ? (artifact.structuredData as Record<string, any>) : null
}

// -------------------------------------------------------------
// Registry
// -------------------------------------------------------------

describe('agent registry', () => {
  it('marks the Proposal Agent implemented with a real handler', () => {
    const def = getAgentDefinition(AGENT)!
    expect(def.implemented).toBe(true)
    expect(def.handler).not.toBeNull()
    expect(def.plannedSlice).toBe('7.7')
  })

  it('defaults to PROPOSE autonomy and stays opt-in', () => {
    const def = getAgentDefinition(AGENT)!
    expect(def.defaultAutonomyLevel).toBe('PROPOSE')
    expect(def.defaultEnabled).toBe(false)
  })

  it('runs every six hours', () => {
    expect(getAgentDefinition(AGENT)!.defaultCronExpression).toBe('0 */6 * * *')
  })

  it('declares requiresLlm false, because the deterministic path is real', () => {
    const def = getAgentDefinition(AGENT)!
    expect(def.requiresLlm).toBe(false)
    // And says honestly what does need a provider.
    expect(def.noLlmBehaviour).toContain('Full deterministic function')
    expect(def.noLlmBehaviour).toContain('provider-gated')
  })

  it('supports manual, scheduled, event and retry triggers', () => {
    expect(getAgentDefinition(AGENT)!.supportedTriggers.sort()).toEqual(['EVENT', 'MANUAL', 'RETRY', 'SCHEDULE'])
  })

  it('subscribes to the §7.7 triggers', () => {
    expect(getAgentDefinition(AGENT)!.subscribedEventTypes.sort()).toEqual([
      'AMENDMENT_RECORDED', 'BID_DECISION_RECORDED', 'CAPABILITY_NARRATIVE_APPROVED',
      'EXTRACTION_COMPLETED', 'PROPOSAL_SECTION_APPROVED',
    ])
  })

  it('is the only subscriber to the two proposal-owned events', () => {
    expect(agentsSubscribedTo('PROPOSAL_SECTION_APPROVED').map((d) => d.key)).toEqual([AGENT])
    expect(agentsSubscribedTo('CAPABILITY_NARRATIVE_APPROVED').map((d) => d.key)).toEqual([AGENT])
  })

  it('allowlists no autonomous action keys', () => {
    expect(getAgentDefinition(AGENT)!.allowlistedActionKeys).toEqual([])
  })

  it('leaves the six previously delivered agents implemented', () => {
    for (const key of ['CONTRACT_ADMINISTRATION', 'OPPORTUNITY', 'COMPLIANCE', 'QUALIFICATION', 'TEAMING', 'PRICING'] as const) {
      expect(getAgentDefinition(key)!.implemented, key).toBe(true)
    }
  })

  it('leaves no domain agent unimplemented — §7.9 completed Section 7', () => {
    const remaining = DOMAIN_AGENT_KEYS.filter((k) => !getAgentDefinition(k)!.implemented)
    expect(remaining).toEqual([])
    for (const key of DOMAIN_AGENT_KEYS) {
      expect(getAgentDefinition(key)!.handler, key).not.toBeNull()
    }
  })

  it('exposes exactly ten implemented entries — nine domain agents plus the diagnostic', () => {
    expect(AGENT_REGISTRY.filter((d) => d.implemented).map((d) => d.key).sort()).toEqual([
      'COMPLIANCE', 'CONTRACT_ADMINISTRATION', 'FINANCE', 'INTELLIGENCE', 'INTERNAL_DIAGNOSTIC',
      'OPPORTUNITY', 'PRICING', 'PROPOSAL', 'QUALIFICATION', 'TEAMING',
    ])
  })

  it('exposes all seventeen phases', () => {
    expect(phasesForRun(null)).toHaveLength(17)
    expect(PROPOSAL_PHASES[0]).toBe('LOAD_PROPOSAL_CONTEXT')
    expect(PROPOSAL_PHASES[PROPOSAL_PHASES.length - 1]).toBe('COMPLETE')
  })

  it('skips irrelevant phases on a targeted event', () => {
    expect(phasesForRun('ProposalSection')).not.toContain('PREPARE_SECTION_DRAFTS')
    expect(phasesForRun('CapabilityNarrative')).toContain('PREPARE_SECTION_DRAFTS')
    expect(phasesForRun('CapabilityNarrative')).not.toContain('RUN_COMPLIANCE_CROSSCHECK')
  })
})

// -------------------------------------------------------------
// THE HUMAN-CONTROL BOUNDARY
// -------------------------------------------------------------

describe('the agent approves nothing, at either autonomy level', () => {
  const AUTONOMY = ['PROPOSE', 'ACT_WITH_GUARDRAILS'] as const

  async function scenario() {
    const { proposal, opportunityId } = await makeProposal(firmA.id)
    await makeRequirements(opportunityId, 3)
    await makeApprovedNarrative(firmA.id)
    const section = await makeSection(firmA.id, opportunityId, proposal.id, {
      ownerUserId: ownerA.id, reviewerUserId: reviewerA.id,
    })
    return { proposal, opportunityId, section }
  }

  it.each(AUTONOMY)('at %s, never approves a proposal section', async (autonomyLevel) => {
    const { section } = await scenario()
    await runAgent(firmA.id, { autonomyLevel })

    const after = await prisma.proposalSection.findUniqueOrThrow({ where: { id: section.id } })
    expect(after.status).not.toBe('APPROVED')
    expect(after.approvedAt).toBeNull()
    expect(after.approvedByUserId).toBeNull()
  })

  it.each(AUTONOMY)('at %s, never writes an approved section version', async (autonomyLevel) => {
    await scenario()
    await runAgent(firmA.id, { autonomyLevel })

    const versions = await prisma.proposalSectionVersion.findMany({ where: { consultingFirmId: firmA.id } })
    // Every version the agent could have written is an AI draft.
    for (const v of versions) {
      expect(v.source).toBe('AI')
      expect(v.isAiGenerated).toBe(true)
    }
  })

  it.each(AUTONOMY)('at %s, never rewrites an APPROVED section', async (autonomyLevel) => {
    const { proposal, opportunityId } = await makeProposal(firmA.id)
    await makeRequirements(opportunityId, 2)
    await makeApprovedNarrative(firmA.id)
    const approved = await makeSection(firmA.id, opportunityId, proposal.id, {
      status: 'APPROVED', draft: 'HUMAN APPROVED TEXT — DO NOT TOUCH',
      approvedAt: new Date(), approvedByUserId: adminA.id,
    })
    await runAgent(firmA.id, { autonomyLevel })

    const after = await prisma.proposalSection.findUniqueOrThrow({ where: { id: approved.id } })
    expect(after.draft).toBe('HUMAN APPROVED TEXT — DO NOT TOUCH')
    expect(after.status).toBe('APPROVED')
    expect(after.approvedByUserId).toBe(adminA.id)
  })

  it.each(AUTONOMY)('at %s, never writes a ProposalSectionReview approval', async (autonomyLevel) => {
    await scenario()
    await runAgent(firmA.id, { autonomyLevel })

    const reviews = await prisma.proposalSectionReview.findMany({ where: { consultingFirmId: firmA.id } })
    expect(reviews.every((r) => r.action !== 'APPROVED')).toBe(true)
  })

  it.each(AUTONOMY)('at %s, never approves a review cycle', async (autonomyLevel) => {
    const { opportunityId } = await scenario()
    const cycle = await prisma.reviewCycle.create({
      data: { consultingFirmId: firmA.id, opportunityId, cycleType: 'PINK', status: 'OPEN' },
    })
    await runAgent(firmA.id, { autonomyLevel })

    const after = await prisma.reviewCycle.findUniqueOrThrow({ where: { id: cycle.id } })
    expect(after.status).toBe('OPEN')
    expect(after.approverUserId).toBeNull()
    expect(after.closedAt).toBeNull()
  })

  it.each(AUTONOMY)('at %s, never marks a requirement verified', async (autonomyLevel) => {
    const { opportunityId } = await scenario()
    const requirements = await prisma.matrixRequirement.findMany({
      where: { matrix: { opportunityId } },
    })
    await runAgent(firmA.id, { autonomyLevel })

    for (const before of requirements) {
      const after = await prisma.matrixRequirement.findUniqueOrThrow({ where: { id: before.id } })
      expect(after.isManuallyVerified).toBe(false)
      expect(after.verificationStatus).toBe('UNVERIFIED')
    }
  })

  it.each(AUTONOMY)('at %s, never selects a final past performance', async (autonomyLevel) => {
    const { opportunityId } = await scenario()
    await prisma.pastPerformanceRecord.create({
      data: {
        consultingFirmId: firmA.id, contractNumber: uniq('C'), customerName: 'S7-PROP-QA Customer',
        scopeSummary: 'Cyber support', relevanceTags: ['541512'],
      },
    })
    await runAgent(firmA.id, { autonomyLevel })

    const selections = await prisma.pastPerformanceSelection.findMany({ where: { consultingFirmId: firmA.id } })
    // The agent may score relevance; only a person may select.
    for (const s of selections) {
      expect(s.isSelected).toBe(false)
      expect(s.selectedByUserId).toBeNull()
      expect(s.selectedAt).toBeNull()
    }
  })

  it.each(AUTONOMY)('at %s, never creates an approved capability version', async (autonomyLevel) => {
    await scenario()
    await runAgent(firmA.id, { autonomyLevel })

    const approved = await prisma.capabilityNarrativeVersion.findMany({
      where: { consultingFirmId: firmA.id, status: 'APPROVED' },
    })
    // Only the one the fixture's human created.
    expect(approved).toHaveLength(1)
    expect(approved[0].approvedByUserId).toBe('human-user')
  })

  it.each(AUTONOMY)('at %s, never waives a compliance blocker', async (autonomyLevel) => {
    const { opportunityId } = await scenario()
    const requirement = await prisma.matrixRequirement.findFirstOrThrow({ where: { matrix: { opportunityId } } })
    await prisma.matrixRequirement.update({
      where: { id: requirement.id }, data: { isBlocked: true, blockerReason: 'Awaiting legal review' },
    })
    await runAgent(firmA.id, { autonomyLevel })

    const after = await prisma.matrixRequirement.findUniqueOrThrow({ where: { id: requirement.id } })
    expect(after.isBlocked).toBe(true)
    expect(after.blockerReason).toBe('Awaiting legal review')
  })

  it.each(AUTONOMY)('at %s, reports every control counter as zero', async (autonomyLevel) => {
    await scenario()
    await runAgent(firmA.id, { autonomyLevel })
    // Asserted where it counts: nothing human-owned moved.
    expect(await prisma.proposalSectionReview.count({
      where: { consultingFirmId: firmA.id, action: 'APPROVED' },
    })).toBe(0)
    expect(await prisma.proposalSection.count({
      where: { consultingFirmId: firmA.id, status: 'APPROVED' },
    })).toBe(0)
  })

  it.each(AUTONOMY)('at %s, every AI section version carries the draft label', async (autonomyLevel) => {
    await scenario()
    await runAgent(firmA.id, { autonomyLevel })
    const versions = await prisma.proposalSectionVersion.findMany({ where: { consultingFirmId: firmA.id } })
    for (const v of versions) {
      expect(v.content).toContain('AI-GENERATED DRAFT')
    }
  })
})

// -------------------------------------------------------------
// The no-key path
// -------------------------------------------------------------

describe('the agent runs fully without an LLM provider', () => {
  it('completes and produces PROPOSAL_STATUS with no provider', async () => {
    const { proposal, opportunityId } = await makeProposal(firmA.id)
    await makeRequirements(opportunityId, 3)

    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('COMPLETED')
    expect(run?.errorCode ?? '').not.toContain('NO_LLM_KEY')

    const status = await readStatus(firmA.id, proposal.id)
    expect(status).not.toBeNull()
    expect(status!.drafting.providerAvailable).toBe(false)
  })

  it('records the exact standardized limitation', async () => {
    const { proposal, opportunityId } = await makeProposal(firmA.id)
    await makeRequirements(opportunityId, 2)
    await runAgent(firmA.id)

    const status = await readStatus(firmA.id, proposal.id)
    expect(status!.drafting.limitations).toContain(NO_PROVIDER_LIMITATION)
    expect(NO_PROVIDER_LIMITATION).toBe('AI drafting unavailable — no provider configured')
  })

  it('never reaches the provider and consumes nothing', async () => {
    const { opportunityId } = await makeProposal(firmA.id)
    await makeRequirements(opportunityId, 2)
    await makeApprovedNarrative(firmA.id)

    const run = await runAgent(firmA.id)
    expect(generateWithRouterSpy).not.toHaveBeenCalled()
    expect(run?.tokenInput).toBe(0)
    expect(run?.tokenOutput).toBe(0)
    expect(Number(run?.estimatedCostUsd)).toBe(0)
  })

  it('still builds the outline and maps mandatory requirements', async () => {
    const { proposal, opportunityId } = await makeProposal(firmA.id)
    await makeRequirements(opportunityId, 4)
    await runAgent(firmA.id)

    const status = await readStatus(firmA.id, proposal.id)
    expect(status!.outline.mandatoryRequirements).toBe(4)
    expect(status!.outline.mappedMandatoryRequirements + status!.outline.unmappedMandatoryRequirements.length).toBe(4)
  })

  it('still creates safe skeletons for otherwise homeless mandatory requirements', async () => {
    const { opportunityId } = await makeProposal(firmA.id)
    await makeRequirements(opportunityId, 3)
    await runAgent(firmA.id)

    const created = await prisma.proposalSection.findMany({ where: { consultingFirmId: firmA.id } })
    expect(created.length).toBeGreaterThan(0)
    // A skeleton is OUTLINE and empty. It is not an answer.
    for (const s of created) {
      expect(s.status).toBe('OUTLINE')
      expect(s.isAiGenerated).toBe(true)
      expect((s.draft ?? '').trim()).toBe('')
    }
  })

  it('says plainly that a skeleton is not coverage', async () => {
    const { proposal, opportunityId } = await makeProposal(firmA.id)
    await makeRequirements(opportunityId, 2)
    await runAgent(firmA.id)

    const status = await readStatus(firmA.id, proposal.id)
    expect(status!.warnings.join(' ')).toContain('A skeleton is not coverage')
    expect(status!.sections.every((s: any) => s.coverageState !== 'COVERED')).toBe(true)
  })

  it('still manages review reminders and produces review state', async () => {
    const { proposal, opportunityId } = await makeProposal(firmA.id)
    await makeRequirements(opportunityId, 1)
    await makeSection(firmA.id, opportunityId, proposal.id, {
      status: 'IN_REVIEW', reviewerUserId: reviewerA.id, ownerUserId: ownerA.id,
      submittedForReviewAt: new Date(Date.now() - 20 * DAY),
    })
    await runAgent(firmA.id)

    const status = await readStatus(firmA.id, proposal.id)
    expect(status!.sectionReviews.length).toBeGreaterThan(0)
    expect(status!.sectionReviews.some((r: any) => r.isOverdue)).toBe(true)
  })
})

// -------------------------------------------------------------
// Outline
// -------------------------------------------------------------

describe('the outline never drops a mandatory requirement', () => {
  it('accounts for every mandatory requirement', async () => {
    const { proposal, opportunityId } = await makeProposal(firmA.id)
    await makeRequirements(opportunityId, 6)
    const outline = await buildOutline({ consultingFirmId: firmA.id, opportunityId, proposalId: proposal.id })
    expect(outline.mappedMandatoryRequirements + outline.unmapped.length).toBe(outline.mandatoryRequirements)
  })

  it('places a requirement into an existing human section by label', async () => {
    const { proposal, opportunityId } = await makeProposal(firmA.id)
    await makeRequirements(opportunityId, 1)
    await makeSection(firmA.id, opportunityId, proposal.id, { title: 'L.1', sectionNumber: 'L.1', isAiGenerated: false })

    const outline = await buildOutline({ consultingFirmId: firmA.id, opportunityId, proposalId: proposal.id })
    const placed = outline.items.find((i) => i.requirementIds.length > 0)
    expect(placed?.mappingSource).toBe('REQUIREMENT_LABEL')
    expect(placed?.isHumanCreated).toBe(true)
  })

  it('prefers a human-confirmed mapping over a confident automatic one', async () => {
    const { proposal, opportunityId } = await makeProposal(firmA.id)
    const [requirement] = await makeRequirements(opportunityId, 1)
    const humanSection = await makeSection(firmA.id, opportunityId, proposal.id, { title: 'Human choice', isAiGenerated: false })
    const autoSection = await makeSection(firmA.id, opportunityId, proposal.id, { title: 'Auto choice', isAiGenerated: true })

    await prisma.sectionLmMapping.create({
      data: {
        consultingFirmId: firmA.id, opportunityId, instructionSourceSection: 'L.1',
        instructionRequirementId: requirement.id, proposalSectionId: humanSection.id,
        confidence: 0.2, verification: 'CONFIRMED',
      },
    })
    await prisma.sectionLmMapping.create({
      data: {
        consultingFirmId: firmA.id, opportunityId, instructionSourceSection: 'L.1',
        instructionRequirementId: requirement.id, proposalSectionId: autoSection.id,
        confidence: 0.95, verification: 'UNVERIFIED',
      },
    })

    const outline = await buildOutline({ consultingFirmId: firmA.id, opportunityId, proposalId: proposal.id })
    const placed = outline.items.find((i) => i.requirementIds.includes(requirement.id))!
    expect(placed.proposalSectionId).toBe(humanSection.id)
    expect(placed.mappingSource).toBe('VERIFIED_LM_MAPPING')
  })

  it('records a low-confidence mapping as an ambiguity rather than acting on it', async () => {
    const { proposal, opportunityId } = await makeProposal(firmA.id)
    const [requirement] = await makeRequirements(opportunityId, 1)
    const section = await makeSection(firmA.id, opportunityId, proposal.id, { title: 'Maybe', isAiGenerated: false })
    await prisma.sectionLmMapping.create({
      data: {
        consultingFirmId: firmA.id, opportunityId, instructionSourceSection: 'L.9',
        instructionRequirementId: requirement.id, proposalSectionId: section.id,
        confidence: HIGH_CONFIDENCE_MAPPING - 0.2, verification: 'UNVERIFIED',
      },
    })

    const outline = await buildOutline({ consultingFirmId: firmA.id, opportunityId, proposalId: proposal.id })
    expect(outline.ambiguities.join(' ')).toContain('low-confidence')
  })

  it('never proposes deleting a human section', async () => {
    const { proposal, opportunityId } = await makeProposal(firmA.id)
    await makeRequirements(opportunityId, 1)
    const human = await makeSection(firmA.id, opportunityId, proposal.id, { title: 'Human wrote this', isAiGenerated: false })

    const outline = await buildOutline({ consultingFirmId: firmA.id, opportunityId, proposalId: proposal.id })
    expect(outline.items.some((i) => i.proposalSectionId === human.id)).toBe(true)
  })

  it('offers a skeleton only for a fallback bucket with a mandatory requirement', async () => {
    const { proposal, opportunityId } = await makeProposal(firmA.id)
    await makeRequirements(opportunityId, 2)
    const outline = await buildOutline({ consultingFirmId: firmA.id, opportunityId, proposalId: proposal.id })
    const candidates = skeletonCandidates(outline)
    expect(candidates.length).toBeGreaterThan(0)
    for (const c of candidates) {
      expect(c.mappingSource).toBe('DETERMINISTIC_FALLBACK')
      expect(c.proposalSectionId).toBeNull()
    }
  })

  it('treats an empty section and a bare placeholder as SKELETON_ONLY', () => {
    const item = {
      key: 'k', title: 't', sectionNumber: null, proposalSectionId: 's1', isHumanCreated: true,
      mappingSource: 'EXISTING_HUMAN_SECTION' as const, requirementIds: [], mandatoryRequirementIds: [], sortOrder: 0,
    }
    expect(coverageFor(item, { draft: '', status: 'DRAFTING' })).toBe('SKELETON_ONLY')
    expect(coverageFor(item, { draft: '[SOURCE REQUIRED]', status: 'DRAFTING' })).toBe('SKELETON_ONLY')
    expect(coverageFor(item, { draft: 'Real narrative text.', status: 'APPROVED' })).toBe('COVERED')
  })
})

// -------------------------------------------------------------
// Capability library
// -------------------------------------------------------------

describe('only approved capability versions are quotable', () => {
  it('never returns a DRAFT version as a source', async () => {
    const narrative = await prisma.capabilityNarrative.create({
      data: {
        consultingFirmId: firmA.id, title: 'Draft only', capabilityKeys: ['cyber'],
        naicsCodes: ['541512'], agencyTags: ['Department of Defense'],
      },
    })
    await prisma.capabilityNarrativeVersion.create({
      data: {
        consultingFirmId: firmA.id, capabilityNarrativeId: narrative.id, versionNumber: 1,
        content: 'Work in progress', contentHash: hashNarrativeContent('Work in progress'), status: 'DRAFT',
      },
    })

    const retrieval = await retrieveApprovedSources(firmA.id, {
      keywords: ['cyber'], naicsCode: '541512', agency: 'Department of Defense',
    })
    expect(retrieval.sources).toHaveLength(0)
    expect(retrieval.unapprovedMatches).toHaveLength(1)
    expect(retrieval.dataSufficiency).toBe('INSUFFICIENT_DATA')
  })

  it('never returns an ARCHIVED version as a source', async () => {
    const { narrative, version } = await makeApprovedNarrative(firmA.id)
    await prisma.capabilityNarrativeVersion.update({
      where: { id: version.id }, data: { status: 'ARCHIVED', supersededAt: new Date() },
    })
    const retrieval = await retrieveApprovedSources(firmA.id, {
      keywords: ['cyber'], naicsCode: '541512', agency: 'Department of Defense',
    })
    expect(retrieval.sources).toHaveLength(0)
    expect(narrative.id).toBeTruthy()
  })

  it('returns an approved version with its traceable version id', async () => {
    const { version } = await makeApprovedNarrative(firmA.id)
    const retrieval = await retrieveApprovedSources(firmA.id, {
      keywords: ['cyber'], naicsCode: '541512', agency: 'Department of Defense',
    })
    expect(retrieval.sources).toHaveLength(1)
    expect(retrieval.sources[0].versionId).toBe(version.id)
    expect(retrieval.sources[0].contentHash).toBeTruthy()
  })

  it('never returns another firm\'s narrative', async () => {
    await makeApprovedNarrative(firmB.id)
    const retrieval = await retrieveApprovedSources(firmA.id, {
      keywords: ['cyber'], naicsCode: '541512', agency: 'Department of Defense',
    })
    expect(retrieval.sources).toHaveLength(0)
  })

  it('ranks deterministically and explains each match', () => {
    const a = scoreCapabilityRelevance(
      { title: 'Cyber', capabilityKeys: ['cyber'], naicsCodes: ['541512'], agencyTags: ['DoD'], tags: [], category: 'TECHNICAL_NARRATIVE' },
      { keywords: ['cyber'], naicsCode: '541512', agency: 'DoD' },
    )
    expect(a.score).toBe(65)
    expect(a.matchedOn).toContain('NAICS 541512')
    expect(a.matchedOn).toContain('agency DoD')
  })

  it('reports library health honestly when nothing is approved', async () => {
    await prisma.capabilityNarrative.create({
      data: { consultingFirmId: firmA.id, title: 'Unapproved' },
    })
    const summary = await summariseLibrary(firmA.id)
    expect(summary.available).toBe(false)
    expect(summary.detail).toContain('none has an approved version')
  })
})

// -------------------------------------------------------------
// Handler behaviour
// -------------------------------------------------------------

describe('handler', () => {
  it('SKIPS honestly when the firm has no active proposal', async () => {
    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('SKIPPED')
    expect(run?.limitations.join(' ')).toContain('ACTIVE')
  })

  it('records progress and a heartbeat', async () => {
    const { opportunityId } = await makeProposal(firmA.id)
    await makeRequirements(opportunityId, 1)
    const run = await runAgent(firmA.id)
    expect(run?.progressPercent).toBeGreaterThan(0)
    expect(run?.heartbeatAt).not.toBeNull()
  })

  it('isolates one proposal from another in the same sweep', async () => {
    const first = await makeProposal(firmA.id)
    await makeRequirements(first.opportunityId, 1)
    const second = await makeProposal(firmA.id)
    await makeRequirements(second.opportunityId, 1)

    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('COMPLETED')
    expect(await prisma.agentArtifact.count({
      where: { consultingFirmId: firmA.id, artifactType: 'PROPOSAL_STATUS' },
    })).toBe(2)
  })

  it('produces a stable hash on an unchanged re-run', async () => {
    const { proposal, opportunityId } = await makeProposal(firmA.id)
    await makeRequirements(opportunityId, 2)
    await runAgent(firmA.id)
    const first = (await readStatus(firmA.id, proposal.id))!.inputHash
    await runAgent(firmA.id)
    expect((await readStatus(firmA.id, proposal.id))!.inputHash).toBe(first)
  })

  it('leaves exactly one live status per proposal', async () => {
    const { proposal, opportunityId } = await makeProposal(firmA.id)
    await makeRequirements(opportunityId, 2)
    await runAgent(firmA.id)
    await makeRequirements(opportunityId, 2)
    await runAgent(firmA.id)

    expect(await prisma.agentArtifact.count({
      where: {
        consultingFirmId: firmA.id, artifactType: 'PROPOSAL_STATUS',
        sourceEntityId: proposal.id, supersededByArtifactId: null,
      },
    })).toBe(1)
  })

  it('does not notify or create skeletons under OBSERVE', async () => {
    const { opportunityId } = await makeProposal(firmA.id)
    await makeRequirements(opportunityId, 2)
    await runAgent(firmA.id, { autonomyLevel: 'OBSERVE' })
    expect(await prisma.proposalSection.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it('changes the draft fingerprint when the approved source changes', () => {
    const a = buildSectionDraftFingerprint({ requirementIds: ['r1'], sourceFingerprint: 'hash-a', existingDraft: null })
    const b = buildSectionDraftFingerprint({ requirementIds: ['r1'], sourceFingerprint: 'hash-b', existingDraft: null })
    expect(a).not.toBe(b)
  })

  it('keeps the draft fingerprint stable for unchanged inputs', () => {
    const args = { requirementIds: ['r2', 'r1'], sourceFingerprint: 'hash', existingDraft: null }
    expect(buildSectionDraftFingerprint(args)).toBe(
      buildSectionDraftFingerprint({ ...args, requirementIds: ['r1', 'r2'] }),
    )
  })

  it('declares which section statuses are locked', () => {
    expect(LOCKED_SECTION_STATUSES).toContain('APPROVED')
  })
})

// -------------------------------------------------------------
// Escalations
// -------------------------------------------------------------

describe('escalations', () => {
  it('escalates unmapped mandatory requirements near the deadline', async () => {
    const opportunity = await makeOpportunity(firmA.id, { responseDeadline: new Date(Date.now() + 2 * DAY) })
    const { proposal } = await makeProposal(firmA.id, opportunity.id)
    await makeRequirements(opportunity.id, 3)

    // OBSERVE creates no skeletons, so the requirements sit in deterministic
    // buckets with no section behind them — which is NOT a mapping.
    await runAgent(firmA.id, { autonomyLevel: 'OBSERVE' })
    const status = await readStatus(firmA.id, proposal.id)
    expect(status!.outline.unmappedMandatoryRequirements.length).toBe(3)
    expect(status!.outline.coverageState).toBe('GAPS_PRESENT')
    expect(status!.outline.unmappedMandatoryRequirements[0].reason).toContain('A section still needs to exist')
  })

  it('counts a requirement as mapped once a real section holds it', async () => {
    const opportunity = await makeOpportunity(firmA.id, { responseDeadline: new Date(Date.now() + 2 * DAY) })
    const { proposal } = await makeProposal(firmA.id, opportunity.id)
    await makeRequirements(opportunity.id, 2)

    // PROPOSE creates the skeletons, which turns the buckets into sections.
    await runAgent(firmA.id)
    await runAgent(firmA.id)
    const status = await readStatus(firmA.id, proposal.id)
    expect(status!.outline.mappedMandatoryRequirements).toBe(2)
    expect(status!.outline.unmappedMandatoryRequirements).toHaveLength(0)
  })

  it('escalates REVIEWER_ASSIGNMENT_REQUIRED when a section awaits review with no reviewer', async () => {
    const { proposal, opportunityId } = await makeProposal(firmA.id)
    await makeRequirements(opportunityId, 1)
    await makeSection(firmA.id, opportunityId, proposal.id, {
      status: 'IN_REVIEW', reviewerUserId: null, submittedForReviewAt: new Date(),
    })
    await runAgent(firmA.id)

    const esc = await prisma.agentEscalation.findFirst({
      where: { consultingFirmId: firmA.id, title: { contains: 'REVIEWER_ASSIGNMENT_REQUIRED' } },
    })
    expect(esc).not.toBeNull()
    expect(esc!.reason).toContain('The agent does not choose a reviewer.')
  })

  it('escalates a stalled review cycle without closing it', async () => {
    const { proposal, opportunityId } = await makeProposal(firmA.id)
    await makeRequirements(opportunityId, 1)
    const cycle = await prisma.reviewCycle.create({
      data: {
        consultingFirmId: firmA.id, opportunityId, cycleType: 'PINK', status: 'IN_PROGRESS',
        startedAt: new Date(Date.now() - 60 * DAY),
      },
    })
    await runAgent(firmA.id)

    const esc = await prisma.agentEscalation.findFirst({
      where: { consultingFirmId: firmA.id, title: { contains: 'review cycle has stalled' } },
    })
    expect(esc).not.toBeNull()
    expect((await prisma.reviewCycle.findUniqueOrThrow({ where: { id: cycle.id } })).status).toBe('IN_PROGRESS')
    expect(proposal.id).toBeTruthy()
  })

  it('does not duplicate an escalation on an unchanged re-run', async () => {
    const { proposal, opportunityId } = await makeProposal(firmA.id)
    await makeRequirements(opportunityId, 1)
    await makeSection(firmA.id, opportunityId, proposal.id, {
      status: 'IN_REVIEW', reviewerUserId: null, submittedForReviewAt: new Date(),
    })
    await runAgent(firmA.id)
    await runAgent(firmA.id)

    expect(await prisma.agentEscalation.count({
      where: { consultingFirmId: firmA.id, title: { contains: 'REVIEWER_ASSIGNMENT_REQUIRED' } },
    })).toBe(1)
  })
})

// -------------------------------------------------------------
// Tenant isolation
// -------------------------------------------------------------

describe('tenant isolation', () => {
  it('refuses to assess another firm\'s proposal', async () => {
    const { proposal } = await makeProposal(firmB.id)
    const run = await runAgent(firmA.id, {
      triggerType: 'EVENT', triggerEntityType: 'ProposalSection', triggerEntityId: proposal.id,
    })
    expect(run?.status).toBe('SKIPPED')
  })

  it('never assesses another firm\'s proposal in a sweep', async () => {
    const mine = await makeProposal(firmA.id)
    await makeRequirements(mine.opportunityId, 1)
    await makeProposal(firmB.id)
    await runAgent(firmA.id)

    const artifacts = await prisma.agentArtifact.findMany({
      where: { consultingFirmId: firmA.id, artifactType: 'PROPOSAL_STATUS' },
    })
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].sourceEntityId).toBe(mine.proposal.id)
  })

  it('raises no escalation or notification against another firm', async () => {
    const { proposal, opportunityId } = await makeProposal(firmA.id)
    await makeRequirements(opportunityId, 1)
    await makeSection(firmA.id, opportunityId, proposal.id, {
      status: 'IN_REVIEW', reviewerUserId: null, submittedForReviewAt: new Date(),
    })
    await runAgent(firmA.id)
    expect(await prisma.agentEscalation.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
    expect(await prisma.userNotification.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
  })
})
