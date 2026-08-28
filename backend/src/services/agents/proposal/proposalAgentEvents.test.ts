// =============================================================
// §7.7 — Proposal Agent events and HTTP surface.
//
// The two NEW triggers are proven through their REAL write paths, not by
// calling the emitter directly: a committed human approval emits exactly one
// event, every other write on the same section emits none, a rolled-back
// approval emits none, and no event crosses a tenant boundary.
//
// The HTTP surface is proven to contain no endpoint that approves a section, a
// review or a cycle, verifies a requirement, selects final past performance or
// submits a proposal. The capability library can only ever be approved by a
// human ADMIN, and a new version always lands as DRAFT.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { prisma } from '../../../config/database'
import {
  buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb,
  type TestFirm, type TestUser,
} from '../../../test-utils/testClient'
import { claimEvents } from '../outbox'
import {
  PROPOSAL_SECTION_APPROVED,
  CAPABILITY_NARRATIVE_APPROVED,
  isHumanSectionApproval,
  emitProposalSectionApproved,
} from './proposalEvents'
import { agentsSubscribedTo } from '../registry'

const BASE = '/api/agents/proposal'
const PROPOSAL_BASE = '/api/proposal'
const DAY = 86_400_000

let app: Express
let firmA: TestFirm
let firmB: TestFirm
let adminA: TestUser
let consultantA: TestUser
let adminB: TestUser

const H = (t: string) => ({ Authorization: `Bearer ${t}` })

let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

beforeAll(async () => {
  app = buildTestApp()
  firmA = await createTestFirm({ name: 'Proposal Event Firm A' })
  firmB = await createTestFirm({ name: 'Proposal Event Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  consultantA = await createTestUser(firmA.id, { role: 'CONSULTANT' })
  adminB = await createTestUser(firmB.id, { role: 'ADMIN' })
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

beforeEach(async () => {
  for (const id of [firmA.id, firmB.id]) {
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: id } })
    await prisma.capabilityNarrativeVersion.deleteMany({ where: { consultingFirmId: id } })
    await prisma.capabilityNarrative.deleteMany({ where: { consultingFirmId: id } })
    await prisma.proposalSectionReview.deleteMany({ where: { consultingFirmId: id } })
    await prisma.proposalSectionVersion.deleteMany({ where: { consultingFirmId: id } })
    await prisma.proposalSection.deleteMany({ where: { consultingFirmId: id } })
    await prisma.proposal.deleteMany({ where: { consultingFirmId: id } })
    await prisma.opportunity.deleteMany({ where: { consultingFirmId: id } })
  }
})

// -------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------

async function makeSection(firm: TestFirm, status = 'DRAFTING') {
  const opportunity = await prisma.opportunity.create({
    data: {
      consultingFirmId: firm.id, samNoticeId: uniq('S7-PROP-EV'),
      title: 'S7-PROP-EV opportunity', agency: 'Department of Defense',
      naicsCode: '541512', responseDeadline: new Date(Date.now() + 30 * DAY),
      status: 'ACTIVE', isDemo: false,
    },
  })
  const proposal = await prisma.proposal.create({
    data: { consultingFirmId: firm.id, opportunityId: opportunity.id, title: 'S7-PROP-EV proposal' },
  })
  const section = await prisma.proposalSection.create({
    data: {
      consultingFirmId: firm.id, opportunityId: opportunity.id, proposalId: proposal.id,
      title: 'S7-PROP-EV technical approach', status, sortOrder: 0,
    },
  })
  return { opportunity, proposal, section }
}

const eventsOfType = (firmId: string, eventType: string) =>
  prisma.agentEvent.findMany({ where: { consultingFirmId: firmId, eventType } })

// =============================================================
// The pure rule
// =============================================================

describe('isHumanSectionApproval', () => {
  it('is true only for a genuine transition into APPROVED', () => {
    expect(isHumanSectionApproval('IN_REVIEW', 'APPROVED')).toBe(true)
    expect(isHumanSectionApproval('CHANGES_REQUESTED', 'APPROVED')).toBe(true)
    expect(isHumanSectionApproval('OUTLINE', 'APPROVED')).toBe(true)
  })

  it('is false when the section is already approved', () => {
    expect(isHumanSectionApproval('APPROVED', 'APPROVED')).toBe(false)
  })

  it('is false for every other target status', () => {
    for (const to of ['OUTLINE', 'DRAFTING', 'IN_REVIEW', 'CHANGES_REQUESTED', 'FINAL']) {
      expect(isHumanSectionApproval('DRAFTING', to)).toBe(false)
    }
  })
})

// =============================================================
// PROPOSAL_SECTION_APPROVED through the real route
// =============================================================

describe('PROPOSAL_SECTION_APPROVED', () => {
  it('emits exactly one event when a human approves a section', async () => {
    const { section } = await makeSection(firmA, 'IN_REVIEW')

    const res = await request(app)
      .post(`${PROPOSAL_BASE}/sections/${section.id}/approve`)
      .set(H(adminA.token))
      .send({})
    expect(res.status).toBe(200)

    const events = await eventsOfType(firmA.id, PROPOSAL_SECTION_APPROVED)
    expect(events).toHaveLength(1)
    expect(events[0].entityId).toBe(section.id)
    expect((events[0].payload as { approvedByUserId: string }).approvedByUserId).toBe(adminA.id)
  })

  it('emits nothing when a section is only submitted for review', async () => {
    const { section } = await makeSection(firmA, 'DRAFTING')

    const res = await request(app)
      .post(`${PROPOSAL_BASE}/sections/${section.id}/submit`)
      .set(H(adminA.token))
      .send({})
    expect(res.status).toBe(200)
    expect(await eventsOfType(firmA.id, PROPOSAL_SECTION_APPROVED)).toHaveLength(0)
  })

  it('emits nothing when changes are requested on an approved section', async () => {
    const { section } = await makeSection(firmA, 'IN_REVIEW')
    await request(app).post(`${PROPOSAL_BASE}/sections/${section.id}/approve`).set(H(adminA.token)).send({})
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: firmA.id } })

    const res = await request(app)
      .post(`${PROPOSAL_BASE}/sections/${section.id}/request-changes`)
      .set(H(adminA.token))
      .send({ comment: 'Tighten the staffing narrative.' })
    expect(res.status).toBe(200)
    expect(await eventsOfType(firmA.id, PROPOSAL_SECTION_APPROVED)).toHaveLength(0)
  })

  it('emits nothing when content is saved as a new version', async () => {
    const { section } = await makeSection(firmA, 'DRAFTING')

    const res = await request(app)
      .put(`${PROPOSAL_BASE}/sections/${section.id}/content`)
      .set(H(adminA.token))
      .send({ content: 'A human wrote this paragraph.' })
    expect(res.status).toBe(200)
    expect(await eventsOfType(firmA.id, PROPOSAL_SECTION_APPROVED)).toHaveLength(0)
    // The write really did happen — the silence is not an inert route.
    expect(await prisma.proposalSectionVersion.count({ where: { proposalSectionId: section.id } })).toBeGreaterThan(0)
  })

  it('emits nothing when the approval is rejected by the status guard', async () => {
    const { section } = await makeSection(firmA, 'DRAFTING')

    const res = await request(app)
      .post(`${PROPOSAL_BASE}/sections/${section.id}/approve`)
      .set(H(adminA.token))
      .send({})
    expect(res.status).toBe(409)
    expect(await eventsOfType(firmA.id, PROPOSAL_SECTION_APPROVED)).toHaveLength(0)
    expect((await prisma.proposalSection.findUnique({ where: { id: section.id } }))!.status).toBe('DRAFTING')
  })

  it('emits nothing when the surrounding transaction rolls back', async () => {
    const { section, opportunity, proposal } = await makeSection(firmA, 'IN_REVIEW')

    await expect(prisma.$transaction(async (tx) => {
      await tx.proposalSection.update({ where: { id: section.id }, data: { status: 'APPROVED' } })
      await emitProposalSectionApproved({
        consultingFirmId: firmA.id,
        proposalSectionId: section.id,
        opportunityId: opportunity.id,
        proposalId: proposal.id,
        approvedByUserId: adminA.id,
      }, tx)
      throw new Error('rollback')
    })).rejects.toThrow('rollback')

    expect(await eventsOfType(firmA.id, PROPOSAL_SECTION_APPROVED)).toHaveLength(0)
    expect((await prisma.proposalSection.findUnique({ where: { id: section.id } }))!.status).toBe('IN_REVIEW')
  })

  it('never leaks an approval event across a tenant boundary', async () => {
    const { section } = await makeSection(firmA, 'IN_REVIEW')
    await request(app).post(`${PROPOSAL_BASE}/sections/${section.id}/approve`).set(H(adminA.token)).send({})

    expect(await eventsOfType(firmB.id, PROPOSAL_SECTION_APPROVED)).toHaveLength(0)
    const claimed = await claimEvents('proposal-event-test', 50, new Date(), { consultingFirmId: firmB.id })
    expect(claimed.some((e) => e.eventType === PROPOSAL_SECTION_APPROVED)).toBe(false)
  })

  it('is a trigger the Proposal Agent actually subscribes to', () => {
    expect(agentsSubscribedTo(PROPOSAL_SECTION_APPROVED).map((d) => d.key)).toContain('PROPOSAL')
    expect(agentsSubscribedTo(CAPABILITY_NARRATIVE_APPROVED).map((d) => d.key)).toContain('PROPOSAL')
  })
})

// =============================================================
// Capability library — human-only approval
// =============================================================

describe('capability library', () => {
  async function createNarrative(token: string, over: Record<string, unknown> = {}) {
    return request(app).post(`${BASE}/library`).set(H(token)).send({
      title: 'S7-PROP-EV cyber capability',
      category: 'TECHNICAL_NARRATIVE',
      capabilityKeys: ['cyber'],
      naicsCodes: ['541512'],
      ...over,
    })
  }

  it('creates a narrative and its first version as DRAFT', async () => {
    const created = await createNarrative(adminA.token)
    expect(created.status, JSON.stringify(created.body)).toBe(201)

    const version = await request(app)
      .post(`${BASE}/library/${created.body.data.narrative.id}/versions`)
      .set(H(adminA.token))
      .send({ content: 'The contractor operates a 24x7 security operations centre.' })
    expect(version.status).toBe(201)
    expect(version.body.data.version.status).toBe('DRAFT')
    expect(version.body.data.version.approvedByUserId).toBeNull()
    expect(await eventsOfType(firmA.id, CAPABILITY_NARRATIVE_APPROVED)).toHaveLength(0)
  })

  it('emits CAPABILITY_NARRATIVE_APPROVED only when an ADMIN approves a version', async () => {
    const created = await createNarrative(adminA.token)
    const version = await request(app)
      .post(`${BASE}/library/${created.body.data.narrative.id}/versions`)
      .set(H(adminA.token))
      .send({ content: 'Approved wording.' })

    const approved = await request(app)
      .post(`${BASE}/library/versions/${version.body.data.version.id}/approve`)
      .set(H(adminA.token))
      .send({})
    expect(approved.status).toBe(200)
    expect(approved.body.data.version.status).toBe('APPROVED')
    expect(approved.body.data.version.approvedByUserId).toBe(adminA.id)

    const events = await eventsOfType(firmA.id, CAPABILITY_NARRATIVE_APPROVED)
    expect(events).toHaveLength(1)
    expect((events[0].payload as { versionId: string }).versionId).toBe(version.body.data.version.id)
  })

  it('refuses approval from a non-admin and emits nothing', async () => {
    const created = await createNarrative(adminA.token)
    const version = await request(app)
      .post(`${BASE}/library/${created.body.data.narrative.id}/versions`)
      .set(H(adminA.token))
      .send({ content: 'Pending wording.' })

    const denied = await request(app)
      .post(`${BASE}/library/versions/${version.body.data.version.id}/approve`)
      .set(H(consultantA.token))
      .send({})
    expect(denied.status).toBe(403)

    expect((await prisma.capabilityNarrativeVersion.findUnique({ where: { id: version.body.data.version.id } }))!.status).toBe('DRAFT')
    expect(await eventsOfType(firmA.id, CAPABILITY_NARRATIVE_APPROVED)).toHaveLength(0)
  })

  it('archives the previously approved version so only one is current', async () => {
    const created = await createNarrative(adminA.token)
    const v1 = await request(app).post(`${BASE}/library/${created.body.data.narrative.id}/versions`).set(H(adminA.token)).send({ content: 'First wording.' })
    await request(app).post(`${BASE}/library/versions/${v1.body.data.version.id}/approve`).set(H(adminA.token)).send({})
    const v2 = await request(app).post(`${BASE}/library/${created.body.data.narrative.id}/versions`).set(H(adminA.token)).send({ content: 'Second wording.' })
    await request(app).post(`${BASE}/library/versions/${v2.body.data.version.id}/approve`).set(H(adminA.token)).send({})

    expect((await prisma.capabilityNarrativeVersion.findUnique({ where: { id: v1.body.data.version.id } }))!.status).toBe('ARCHIVED')
    expect((await prisma.capabilityNarrativeVersion.findUnique({ where: { id: v2.body.data.version.id } }))!.status).toBe('APPROVED')
    expect((await prisma.capabilityNarrative.findUnique({ where: { id: created.body.data.narrative.id } }))!.currentApprovedVersionId).toBe(v2.body.data.version.id)
  })

  it('cannot approve another firm’s version', async () => {
    const created = await createNarrative(adminA.token)
    const version = await request(app).post(`${BASE}/library/${created.body.data.narrative.id}/versions`).set(H(adminA.token)).send({ content: 'Firm A wording.' })

    const cross = await request(app)
      .post(`${BASE}/library/versions/${version.body.data.version.id}/approve`)
      .set(H(adminB.token))
      .send({})
    expect(cross.status).toBe(404)
    expect((await prisma.capabilityNarrativeVersion.findUnique({ where: { id: version.body.data.version.id } }))!.status).toBe('DRAFT')
    expect(await eventsOfType(firmB.id, CAPABILITY_NARRATIVE_APPROVED)).toHaveLength(0)
  })

  it('never lists another firm’s narratives', async () => {
    await createNarrative(adminA.token)
    const listB = await request(app).get(`${BASE}/library`).set(H(adminB.token))
    expect(listB.status).toBe(200)
    expect(listB.body.data.narratives).toHaveLength(0)
  })

  it('rejects an unauthenticated request', async () => {
    expect((await request(app).get(`${BASE}/library`)).status).toBe(401)
  })
})

// =============================================================
// §4 — the HTTP surface itself
// =============================================================

describe('proposal agent HTTP surface', () => {
  it('exposes no endpoint that approves, verifies, selects or submits', async () => {
    const forbidden = [
      '/sections/any-id/approve',
      '/reviews/any-id/approve',
      '/cycles/any-id/approve',
      '/cycles/any-id/sign-off',
      '/requirements/any-id/verify',
      '/past-performance/select',
      '/attestations/any-id/satisfy',
      '/blockers/any-id/waive',
      '/submit',
      '/send',
    ]
    for (const path of forbidden) {
      const res = await request(app).post(`${BASE}${path}`).set(H(adminA.token)).send({})
      expect(res.status, `POST ${BASE}${path} must not exist`).toBe(404)
    }
  })

  it('returns a null status for a proposal the agent has not assessed', async () => {
    const { proposal } = await makeSection(firmA)
    const res = await request(app).get(`${BASE}/status/${proposal.id}`).set(H(adminA.token))
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBeNull()
    expect(res.body.data.policy.notes.length).toBeGreaterThan(0)
  })

  it('404s on another firm’s proposal status', async () => {
    const { proposal } = await makeSection(firmA)
    const res = await request(app).get(`${BASE}/status/${proposal.id}`).set(H(adminB.token))
    expect(res.status).toBe(404)
  })
})
