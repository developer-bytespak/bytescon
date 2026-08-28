// =============================================================
// §7.3 — Compliance domain events through the real HTTP write paths, plus the
// Compliance Agent API and bonding CRUD.
//
// Re-proves the transactional-outbox properties for the two NEW events and the
// reused amendment event: a committed write emits exactly one event, a
// rolled-back write emits none, a benign duplicate never rolls the business
// write back, a replay creates one run, and no event crosses a tenant boundary.
//
// Also proves the extraction event cannot loop.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../config/database'
import {
  buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb,
  type TestFirm, type TestUser,
} from '../test-utils/testClient'
import { processOutbox } from '../services/agents/outbox'
import {
  SOLICITATION_DOCUMENT_ADDED,
  EXTRACTION_COMPLETED,
  AMENDMENT_RECORDED,
  emitSolicitationDocumentAdded,
  emitExtractionCompleted,
  emitAmendmentRecorded,
} from '../services/agents/compliance/complianceEvents'
import { phasesForRun } from '../services/agents/compliance/complianceAgentHandler'

let app: Express
let firmA: TestFirm
let firmB: TestFirm
let adminA: TestUser
let consultantA: TestUser
let adminB: TestUser

const H = (t: string) => ({ Authorization: `Bearer ${t}` })
const MILESTONES = '/api/milestones'
const REQUIREMENTS = '/api/requirements-intel'
const CA = '/api/agents/compliance'

let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

const TEXT = `
SECTION L — INSTRUCTIONS TO OFFERORS
L.1 The offeror shall submit a technical volume not exceeding 30 pages.
SECTION M — EVALUATION FACTORS
M.1 The Government will evaluate the technical volume for completeness.
52.204-7 System for Award Management. The Contractor shall insert this clause in all subcontracts.
Proposal Deadline: 2027-03-01
`

beforeAll(async () => {
  app = buildTestApp()
  firmA = await createTestFirm({ name: 'Compliance Event Firm A' })
  firmB = await createTestFirm({ name: 'Compliance Event Firm B' })
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
    await prisma.agentRun.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentEscalation.deleteMany({ where: { consultingFirmId: id } })
    await prisma.bondingCapacity.deleteMany({ where: { consultingFirmId: id } })
    await prisma.opportunity.deleteMany({ where: { consultingFirmId: id } })
  }
})

const eventsOf = (firmId: string, type: string) =>
  prisma.agentEvent.findMany({ where: { consultingFirmId: firmId, eventType: type } })

async function makeOpportunity(firmId: string) {
  return prisma.opportunity.create({
    data: {
      consultingFirmId: firmId,
      samNoticeId: uniq('S7-COMP-QA'),
      title: 'Compliance event fixture',
      agency: 'GSA',
      naicsCode: '541512',
      setAsideType: 'NONE',
      description: TEXT,
      responseDeadline: new Date(Date.now() + 60 * 86_400_000),
      status: 'ACTIVE',
      isDemo: false,
    },
  })
}

async function makeDocument(opportunityId: string) {
  return prisma.opportunityDocument.create({
    data: {
      opportunityId,
      fileName: uniq('doc') + '.pdf',
      storageKey: uniq('key'),
      fileType: 'application/pdf',
      fileSize: 512,
      isAmendment: false,
      analysisStatus: 'PENDING',
      extractionStatus: 'PENDING',
    },
  })
}

// -------------------------------------------------------------
// SOLICITATION_DOCUMENT_ADDED
// -------------------------------------------------------------

describe('SOLICITATION_DOCUMENT_ADDED', () => {
  it('emits exactly one event per document', async () => {
    const opp = await makeOpportunity(firmA.id)
    const doc = await makeDocument(opp.id)

    await prisma.$transaction(async (tx) => {
      await emitSolicitationDocumentAdded(tx, {
        consultingFirmId: firmA.id, documentId: doc.id, opportunityId: opp.id,
        fileName: doc.fileName, fileType: doc.fileType, isAmendment: false,
      })
    })

    const events = await eventsOf(firmA.id, SOLICITATION_DOCUMENT_ADDED)
    expect(events).toHaveLength(1)
    expect(events[0].entityType).toBe('OpportunityDocument')
    expect(events[0].entityId).toBe(doc.id)
  })

  it('carries identifiers only, never document bytes or text', async () => {
    const opp = await makeOpportunity(firmA.id)
    const doc = await makeDocument(opp.id)
    await prisma.$transaction(async (tx) => {
      await emitSolicitationDocumentAdded(tx, {
        consultingFirmId: firmA.id, documentId: doc.id, opportunityId: opp.id,
        fileName: doc.fileName, fileType: doc.fileType, isAmendment: false,
      })
    })
    const [event] = await eventsOf(firmA.id, SOLICITATION_DOCUMENT_ADDED)
    const payload = JSON.stringify(event.payload)
    expect(payload.length).toBeLessThan(600)
    expect(payload).not.toContain('SECTION L')
  })

  it('emits zero events when the business write is rolled back', async () => {
    const opp = await makeOpportunity(firmA.id)
    await prisma.$transaction(async (tx) => {
      const row = await tx.opportunityDocument.create({
        data: {
          opportunityId: opp.id, fileName: uniq('rollback') + '.pdf', storageKey: uniq('k'),
          fileType: 'application/pdf', fileSize: 1, isAmendment: false,
          analysisStatus: 'PENDING', extractionStatus: 'PENDING',
        },
      })
      await emitSolicitationDocumentAdded(tx, {
        consultingFirmId: firmA.id, documentId: row.id, opportunityId: opp.id,
        fileName: row.fileName, fileType: row.fileType, isAmendment: false,
      })
      throw new Error('rollback')
    }).catch(() => undefined)

    expect(await eventsOf(firmA.id, SOLICITATION_DOCUMENT_ADDED)).toHaveLength(0)
    expect(await prisma.opportunityDocument.count({ where: { opportunityId: opp.id } })).toBe(0)
  })

  it('absorbs a duplicate emission without rolling back the business write', async () => {
    const opp = await makeOpportunity(firmA.id)
    const doc = await makeDocument(opp.id)

    await prisma.$transaction(async (tx) => {
      await tx.opportunityDocument.update({ where: { id: doc.id }, data: { extractionStatus: 'EXTRACTING' } })
      const args = {
        consultingFirmId: firmA.id, documentId: doc.id, opportunityId: opp.id,
        fileName: doc.fileName, fileType: doc.fileType, isAmendment: false,
      }
      const first = await emitSolicitationDocumentAdded(tx, args)
      const second = await emitSolicitationDocumentAdded(tx, args)
      expect(first.created).toBe(true)
      expect(second.created).toBe(false)
      expect(second.eventId).toBe(first.eventId)
    })

    expect(await eventsOf(firmA.id, SOLICITATION_DOCUMENT_ADDED)).toHaveLength(1)
    const after = await prisma.opportunityDocument.findUniqueOrThrow({ where: { id: doc.id } })
    expect(after.extractionStatus).toBe('EXTRACTING')
  })
})

// -------------------------------------------------------------
// EXTRACTION_COMPLETED
// -------------------------------------------------------------

describe('EXTRACTION_COMPLETED', () => {
  it('emits once for a successful extraction through the canonical route', async () => {
    const opp = await makeOpportunity(firmA.id)
    const res = await request(app).post(`${REQUIREMENTS}/extraction/${opp.id}`).set(H(adminA.token)).send({})
    expect(res.status).toBe(200)

    const events = await eventsOf(firmA.id, EXTRACTION_COMPLETED)
    expect(events).toHaveLength(1)
    expect(events[0].entityType).toBe('SolicitationExtractionJob')
    expect(events[0].entityId).toBe(res.body.data.jobId)
  })

  it('does not re-announce an already-processed extraction', async () => {
    const opp = await makeOpportunity(firmA.id)
    await request(app).post(`${REQUIREMENTS}/extraction/${opp.id}`).set(H(adminA.token)).send({})
    // Same content → the pipeline short-circuits as alreadyProcessed.
    const again = await request(app).post(`${REQUIREMENTS}/extraction/${opp.id}`).set(H(adminA.token)).send({})

    expect(again.body.data.alreadyProcessed).toBe(true)
    expect(await eventsOf(firmA.id, EXTRACTION_COMPLETED)).toHaveLength(1)
  })

  it('CANNOT loop: an extraction-completed run has no extraction phase', async () => {
    // The structural guarantee, asserted directly.
    expect(phasesForRun('SolicitationExtractionJob')).not.toContain('RUN_EXTRACTION')

    const opp = await makeOpportunity(firmA.id)
    await request(app).post(`${REQUIREMENTS}/extraction/${opp.id}`).set(H(adminA.token)).send({})
    const jobsBefore = await prisma.solicitationExtractionJob.count({ where: { consultingFirmId: firmA.id } })

    // Drain the event: it creates a Compliance run which must NOT extract again.
    await processOutbox('test-loop-1', 20, new Date(), { consultingFirmId: firmA.id })
    const runs = await prisma.agentRun.findMany({
      where: { consultingFirmId: firmA.id, agentKey: 'COMPLIANCE', triggerType: 'EVENT' },
    })
    expect(runs.length).toBeGreaterThan(0)

    // No second extraction job, and therefore no second completion event.
    expect(await prisma.solicitationExtractionJob.count({ where: { consultingFirmId: firmA.id } })).toBe(jobsBefore)
    expect(await eventsOf(firmA.id, EXTRACTION_COMPLETED)).toHaveLength(1)
  })

  it('emits zero events when the surrounding transaction rolls back', async () => {
    await prisma.$transaction(async (tx) => {
      await emitExtractionCompleted(tx, {
        consultingFirmId: firmA.id, extractionJobId: 'job-rollback', opportunityId: 'opp-1',
        documentId: null, status: 'SUCCEEDED', requirementsCreated: 1, clausesCreated: 0,
        mappingsCreated: 0, unresolvedCount: 0,
      })
      throw new Error('rollback')
    }).catch(() => undefined)
    expect(await eventsOf(firmA.id, EXTRACTION_COMPLETED)).toHaveLength(0)
  })

  it('announces a later status change on the same job', async () => {
    for (const status of ['PARTIAL', 'SUCCEEDED']) {
      await prisma.$transaction(async (tx) => {
        await emitExtractionCompleted(tx, {
          consultingFirmId: firmA.id, extractionJobId: 'job-1', opportunityId: 'opp-1',
          documentId: null, status, requirementsCreated: 1, clausesCreated: 0,
          mappingsCreated: 0, unresolvedCount: 0,
        })
      })
    }
    // Distinct terminal statuses are distinct business facts.
    expect(await eventsOf(firmA.id, EXTRACTION_COMPLETED)).toHaveLength(2)
  })
})

// -------------------------------------------------------------
// AMENDMENT_RECORDED
// -------------------------------------------------------------

describe('AMENDMENT_RECORDED', () => {
  it('emits exactly one event when an amendment is recorded', async () => {
    const opp = await makeOpportunity(firmA.id)
    const res = await request(app).post(`${MILESTONES}/amendments/${opp.id}`).set(H(adminA.token))
      .send({ text: TEXT, amendmentNumber: '0001' })
    expect(res.status).toBe(200)

    const events = await eventsOf(firmA.id, AMENDMENT_RECORDED)
    expect(events).toHaveLength(1)
    expect(events[0].entityType).toBe('AmendmentRevision')
    expect(events[0].entityId).toBe(res.body.data.revisionId)
  })

  it('emits nothing when identical amendment content is re-posted', async () => {
    const opp = await makeOpportunity(firmA.id)
    await request(app).post(`${MILESTONES}/amendments/${opp.id}`).set(H(adminA.token)).send({ text: TEXT })
    const again = await request(app).post(`${MILESTONES}/amendments/${opp.id}`).set(H(adminA.token)).send({ text: TEXT })

    expect(again.body.data.isNew).toBe(false)
    expect(await eventsOf(firmA.id, AMENDMENT_RECORDED)).toHaveLength(1)
  })

  it('emits zero events when the surrounding transaction rolls back', async () => {
    await prisma.$transaction(async (tx) => {
      await emitAmendmentRecorded(tx, {
        consultingFirmId: firmA.id, revisionId: 'rev-rollback', opportunityId: 'opp-1',
        revisionNo: 1, amendmentNumber: null, changedRequirements: 1, changedDeadlines: 0, changedClauses: 0,
      })
      throw new Error('rollback')
    }).catch(() => undefined)
    expect(await eventsOf(firmA.id, AMENDMENT_RECORDED)).toHaveLength(0)
  })

  it('cannot record an amendment against another firm\'s opportunity', async () => {
    const oppB = await makeOpportunity(firmB.id)
    const res = await request(app).post(`${MILESTONES}/amendments/${oppB.id}`).set(H(adminA.token)).send({ text: TEXT })
    expect(res.status).toBe(404)
    expect(await eventsOf(firmA.id, AMENDMENT_RECORDED)).toHaveLength(0)
    expect(await eventsOf(firmB.id, AMENDMENT_RECORDED)).toHaveLength(0)
  })
})

// -------------------------------------------------------------
// Outbox fan-out
// -------------------------------------------------------------

describe('outbox fan-out', () => {
  async function drainForEntity(entityId: string, attempts = 8) {
    for (let i = 0; i < attempts; i++) {
      await processOutbox(`test-comp-${i}`, 20, new Date(), { consultingFirmId: firmA.id })
      const run = await prisma.agentRun.findFirst({
        where: { consultingFirmId: firmA.id, agentKey: 'COMPLIANCE', triggerType: 'EVENT', triggerEntityId: entityId },
      })
      if (run) return run
      await new Promise((r) => setTimeout(r, 50))
    }
    return null
  }

  it('creates one Compliance run per event, and only one on replay', async () => {
    const opp = await makeOpportunity(firmA.id)
    const res = await request(app).post(`${MILESTONES}/amendments/${opp.id}`).set(H(adminA.token)).send({ text: TEXT })
    const revisionId = res.body.data.revisionId as string

    const run = await drainForEntity(revisionId)
    expect(run).not.toBeNull()

    await processOutbox('test-comp-replay', 20, new Date(), { consultingFirmId: firmA.id })
    const runs = await prisma.agentRun.findMany({
      where: { consultingFirmId: firmA.id, agentKey: 'COMPLIANCE', triggerType: 'EVENT', triggerEntityId: revisionId },
    })
    expect(runs).toHaveLength(1)
  })

  it('never creates a run for another tenant from an event', async () => {
    const opp = await makeOpportunity(firmA.id)
    const res = await request(app).post(`${MILESTONES}/amendments/${opp.id}`).set(H(adminA.token)).send({ text: TEXT })
    await drainForEntity(res.body.data.revisionId as string)
    expect(await prisma.agentRun.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
  })
})

// -------------------------------------------------------------
// API
// -------------------------------------------------------------

describe('GET /latest', () => {
  it('reports honest empty state before the agent has ever run', async () => {
    const res = await request(app).get(`${CA}/latest`).set(H(adminA.token))
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBeNull()
    expect(res.body.data.lastRun).toBeNull()
    expect(res.body.data.registration.sam.missing).toBe(true)
  })

  it('surfaces the documented policy so the UI hard-codes no threshold', async () => {
    const res = await request(app).get(`${CA}/latest`).set(H(adminA.token))
    expect(res.body.data.policy.samExpiryEscalationDays).toBe(30)
    expect(res.body.data.policy.amendmentDeadlineWorkingDays).toBe(5)
    expect(res.body.data.policy.minMappingSimilarity).toBe(0.28)
    expect(res.body.data.policy.clearMappingSimilarity).toBe(0.5)
  })

  it('is readable by a CONSULTANT', async () => {
    expect((await request(app).get(`${CA}/latest`).set(H(consultantA.token))).status).toBe(200)
  })

  it('rejects an unauthenticated request', async () => {
    expect((await request(app).get(`${CA}/latest`)).status).toBe(401)
  })
})

describe('GET /opportunity/:id', () => {
  it('returns the opportunity view', async () => {
    const opp = await makeOpportunity(firmA.id)
    const res = await request(app).get(`${CA}/opportunity/${opp.id}`).set(H(adminA.token))
    expect(res.status).toBe(200)
    expect(res.body.data.opportunity.id).toBe(opp.id)
    expect(res.body.data.compliance).toBeNull()
  })

  it('does not disclose another firm\'s opportunity', async () => {
    const oppB = await makeOpportunity(firmB.id)
    expect((await request(app).get(`${CA}/opportunity/${oppB.id}`).set(H(adminA.token))).status).toBe(404)
  })
})

describe('bonding capacity API', () => {
  const body = {
    suretyName: 'S7-COMP-QA Surety',
    singleProjectLimit: '2000000.00',
    aggregateLimit: '8000000.00',
    committedAmount: '1500000.25',
  }

  it('lets an ADMIN record capacity and derives headroom exactly', async () => {
    const res = await request(app).post(`${CA}/bonding`).set(H(adminA.token)).send(body)
    expect(res.status).toBe(201)
    expect(res.body.data.assessment.state).toBe('SUFFICIENT')
    expect(res.body.data.assessment.availableCapacity).toBe('6499999.75')
  })

  it('audits the human action', async () => {
    const res = await request(app).post(`${CA}/bonding`).set(H(adminA.token)).send(body)
    const audit = await prisma.auditEvent.findFirst({
      where: { consultingFirmId: firmA.id, entityType: 'BondingCapacity', entityId: res.body.data.id },
    })
    expect(audit).not.toBeNull()
    expect(audit?.actorUserId).toBe(adminA.id)
  })

  it('refuses a CONSULTANT write', async () => {
    const res = await request(app).post(`${CA}/bonding`).set(H(consultantA.token)).send(body)
    expect(res.status).toBe(403)
    expect(await prisma.bondingCapacity.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it('lets a CONSULTANT read', async () => {
    await request(app).post(`${CA}/bonding`).set(H(adminA.token)).send(body)
    const res = await request(app).get(`${CA}/bonding`).set(H(consultantA.token))
    expect(res.status).toBe(200)
    expect(res.body.data.records).toHaveLength(1)
  })

  it('reports INSUFFICIENT_DATA rather than inventing headroom', async () => {
    const res = await request(app).post(`${CA}/bonding`).set(H(adminA.token))
      .send({ aggregateLimit: '5000000.00' })
    expect(res.body.data.assessment.state).toBe('INSUFFICIENT_DATA')
    expect(res.body.data.assessment.availableCapacity).toBeNull()
  })

  it('updates a record and recomputes the assessment', async () => {
    const created = await request(app).post(`${CA}/bonding`).set(H(adminA.token)).send(body)
    const updated = await request(app).put(`${CA}/bonding/${created.body.data.id}`).set(H(adminA.token))
      .send({ committedAmount: '8000000.00' })
    expect(updated.status).toBe(200)
    expect(updated.body.data.assessment.state).toBe('INSUFFICIENT')
  })

  it('archives rather than deletes', async () => {
    const created = await request(app).post(`${CA}/bonding`).set(H(adminA.token)).send(body)
    const archived = await request(app).post(`${CA}/bonding/${created.body.data.id}/archive`).set(H(adminA.token))
    expect(archived.status).toBe(200)
    expect(archived.body.data.status).toBe('ARCHIVED')
    expect(await prisma.bondingCapacity.count({ where: { consultingFirmId: firmA.id } })).toBe(1)
  })

  it('never exposes or mutates another firm\'s bonding record', async () => {
    const created = await prisma.bondingCapacity.create({
      data: { consultingFirmId: firmB.id, aggregateLimit: new Prisma.Decimal('1000000.00') },
    })
    const list = await request(app).get(`${CA}/bonding`).set(H(adminA.token))
    expect(list.body.data.records).toHaveLength(0)

    expect((await request(app).put(`${CA}/bonding/${created.id}`).set(H(adminA.token)).send({ notes: 'x' })).status).toBe(404)
    expect((await request(app).post(`${CA}/bonding/${created.id}/archive`).set(H(adminA.token))).status).toBe(404)

    const after = await prisma.bondingCapacity.findUniqueOrThrow({ where: { id: created.id } })
    expect(after.status).toBe('ACTIVE')
    expect(after.notes).toBeNull()
  })

  it('rejects a non-numeric money value', async () => {
    const res = await request(app).post(`${CA}/bonding`).set(H(adminA.token)).send({ aggregateLimit: 'not-a-number' })
    expect(res.status).toBe(422)
  })
})
