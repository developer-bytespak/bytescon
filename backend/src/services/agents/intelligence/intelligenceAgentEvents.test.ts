// =============================================================
// §7.9 — Intelligence events, the HTTP surface, and the no-prompt proof.
//
// The two NEW emitters are proven through their REAL write paths. The third
// trigger, CONTRACT_AWARDED, is proven to be the §7.1 emitter REUSED rather
// than duplicated — a second emitter would double-count every award.
//
// The HTTP surface is proven to contain no endpoint that changes a decision, a
// pursuit, a weight, a price or a capability. Dismissing a recommendation is
// the only write, and it changes the status of the agent's own advice.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { prisma } from '../../../config/database'
import {
  buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb,
  type TestFirm, type TestUser,
} from '../../../test-utils/testClient'
import { claimEvents } from '../outbox'
import {
  SUBMISSION_OUTCOME_RECORDED, CALIBRATION_UPDATED, CONTRACT_AWARDED,
  INTELLIGENCE_EVENT_TYPES, isOutcomeChange, emitSubmissionOutcomeRecorded,
} from './intelligenceEvents'
import { agentsSubscribedTo } from '../registry'
import { activateCalibration } from '../../scoring/tenantCalibration'

const BASE = '/api/agents/intelligence'
const SUBMISSIONS_BASE = '/api/submissions'
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
  firmA = await createTestFirm({ name: 'Intelligence Event Firm A' })
  firmB = await createTestFirm({ name: 'Intelligence Event Firm B' })
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
    await prisma.captureRecommendation.deleteMany({ where: { consultingFirmId: id } })
    await prisma.winLossSegment.deleteMany({ where: { consultingFirmId: id } })
    await prisma.calibrationSample.deleteMany({ where: { calibration: { consultingFirmId: id } } })
    await prisma.tenantCalibration.deleteMany({ where: { consultingFirmId: id } })
    await prisma.submissionRecord.deleteMany({ where: { consultingFirmId: id } })
    await prisma.opportunity.deleteMany({ where: { consultingFirmId: id } })
    await prisma.clientCompany.deleteMany({ where: { consultingFirmId: id } })
  }
})

// -------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------

async function makeSubmission(firm: TestFirm, outcome: 'WON' | 'LOST' | null = null) {
  const client = await prisma.clientCompany.create({
    data: { consultingFirmId: firm.id, name: `S7-INTEL-EV client ${uniq('c')}` },
  })
  const opportunity = await prisma.opportunity.create({
    data: {
      consultingFirmId: firm.id, samNoticeId: uniq('S7-INTEL-EV'),
      title: 'S7-INTEL-EV support', agency: 'Department of Defense', naicsCode: '541512',
      responseDeadline: new Date(Date.now() - 60 * DAY), status: 'ACTIVE', isDemo: false,
    },
  })
  return prisma.submissionRecord.create({
    data: {
      consultingFirmId: firm.id, clientCompanyId: client.id, opportunityId: opportunity.id,
      submittedAt: new Date(Date.now() - 50 * DAY),
      outcome, outcomeRecordedAt: outcome ? new Date() : null,
    },
  })
}

async function makeCalibration(firmId: string, version: number, state: 'DRAFT' | 'ACTIVE' = 'DRAFT') {
  return prisma.tenantCalibration.create({
    data: {
      consultingFirmId: firmId, version, method: 'platt', params: { a: 1, b: 0 },
      sampleSize: 40, trainingStart: new Date(Date.now() - 365 * DAY), trainingEnd: new Date(),
      state, activatedAt: state === 'ACTIVE' ? new Date() : null,
    },
  })
}

const eventsOfType = (firmId: string, eventType: string) =>
  prisma.agentEvent.findMany({ where: { consultingFirmId: firmId, eventType } })

// =============================================================
// The pure rule
// =============================================================

describe('isOutcomeChange', () => {
  it('is true when the recorded result actually changes', () => {
    expect(isOutcomeChange(null, 'WON')).toBe(true)
    expect(isOutcomeChange('WON', 'LOST')).toBe(true)
    expect(isOutcomeChange('LOST', 'NO_AWARD')).toBe(true)
  })

  it('is false when the same result is re-saved', () => {
    expect(isOutcomeChange('WON', 'WON')).toBe(false)
  })
})

// =============================================================
// SUBMISSION_OUTCOME_RECORDED
// =============================================================

describe('SUBMISSION_OUTCOME_RECORDED', () => {
  it('emits exactly one event when a person records an outcome', async () => {
    const submission = await makeSubmission(firmA)

    const res = await request(app)
      .patch(`${SUBMISSIONS_BASE}/${submission.id}/outcome`)
      .set(H(adminA.token))
      .send({ outcome: 'WON' })
    expect(res.status).toBe(200)

    const events = await eventsOfType(firmA.id, SUBMISSION_OUTCOME_RECORDED)
    expect(events).toHaveLength(1)
    expect(events[0].entityId).toBe(submission.id)
    expect((events[0].payload as { toOutcome: string }).toOutcome).toBe('WON')
    expect((events[0].payload as { fromOutcome: string | null }).fromOutcome).toBeNull()
  })

  it('emits again when an outcome is CORRECTED — the measurement changes', async () => {
    const submission = await makeSubmission(firmA)
    await request(app).patch(`${SUBMISSIONS_BASE}/${submission.id}/outcome`).set(H(adminA.token)).send({ outcome: 'WON' })
    await request(app).patch(`${SUBMISSIONS_BASE}/${submission.id}/outcome`).set(H(adminA.token)).send({ outcome: 'LOST' })

    const events = await eventsOfType(firmA.id, SUBMISSION_OUTCOME_RECORDED)
    expect(events).toHaveLength(2)
    expect(events.map((e) => (e.payload as { toOutcome: string }).toOutcome).sort()).toEqual(['LOST', 'WON'])
  })

  it('emits nothing when the same outcome is re-saved with new notes', async () => {
    const submission = await makeSubmission(firmA)
    await request(app).patch(`${SUBMISSIONS_BASE}/${submission.id}/outcome`).set(H(adminA.token)).send({ outcome: 'WON' })
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: firmA.id } })

    const res = await request(app)
      .patch(`${SUBMISSIONS_BASE}/${submission.id}/outcome`)
      .set(H(adminA.token))
      .send({ outcome: 'WON', notes: 'Adding a note only.' })
    expect(res.status).toBe(200)
    expect(await eventsOfType(firmA.id, SUBMISSION_OUTCOME_RECORDED)).toHaveLength(0)
  })

  it('emits nothing when validation rejects the outcome', async () => {
    const submission = await makeSubmission(firmA)
    const res = await request(app)
      .patch(`${SUBMISSIONS_BASE}/${submission.id}/outcome`)
      .set(H(adminA.token))
      .send({ outcome: 'DEFINITELY_WON' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(await eventsOfType(firmA.id, SUBMISSION_OUTCOME_RECORDED)).toHaveLength(0)
    expect((await prisma.submissionRecord.findUniqueOrThrow({ where: { id: submission.id } })).outcome).toBeNull()
  })

  it('emits nothing when the surrounding transaction rolls back', async () => {
    const submission = await makeSubmission(firmA)

    await expect(prisma.$transaction(async (tx) => {
      await tx.submissionRecord.update({ where: { id: submission.id }, data: { outcome: 'WON', outcomeRecordedAt: new Date() } })
      await emitSubmissionOutcomeRecorded(tx, {
        consultingFirmId: firmA.id, submissionRecordId: submission.id,
        opportunityId: submission.opportunityId, fromOutcome: null, toOutcome: 'WON', recordedByUserId: adminA.id,
      })
      throw new Error('rollback')
    })).rejects.toThrow('rollback')

    expect(await eventsOfType(firmA.id, SUBMISSION_OUTCOME_RECORDED)).toHaveLength(0)
    expect((await prisma.submissionRecord.findUniqueOrThrow({ where: { id: submission.id } })).outcome).toBeNull()
  })

  it('treats a benign duplicate as harmless and never rolls the write back', async () => {
    const submission = await makeSubmission(firmA)

    const committed = await prisma.$transaction(async (tx) => {
      const args = {
        consultingFirmId: firmA.id, submissionRecordId: submission.id,
        opportunityId: submission.opportunityId, fromOutcome: null, toOutcome: 'WON' as const, recordedByUserId: adminA.id,
      }
      await emitSubmissionOutcomeRecorded(tx, args)
      await emitSubmissionOutcomeRecorded(tx, args)
      return tx.submissionRecord.update({ where: { id: submission.id }, data: { outcomeNotes: 'business write survived' } })
    })

    expect(committed.outcomeNotes).toBe('business write survived')
    expect(await eventsOfType(firmA.id, SUBMISSION_OUTCOME_RECORDED)).toHaveLength(1)
  })

  it('never leaks across a tenant boundary', async () => {
    const submission = await makeSubmission(firmA)
    await request(app).patch(`${SUBMISSIONS_BASE}/${submission.id}/outcome`).set(H(adminA.token)).send({ outcome: 'WON' })

    expect(await eventsOfType(firmB.id, SUBMISSION_OUTCOME_RECORDED)).toHaveLength(0)
    const claimed = await claimEvents('intel-event-test', 50, new Date(), { consultingFirmId: firmB.id })
    expect(claimed.some((e) => (INTELLIGENCE_EVENT_TYPES as readonly string[]).includes(e.eventType))).toBe(false)
  })

  it('rejects an attempt to record another firm’s outcome', async () => {
    const submission = await makeSubmission(firmA)
    const res = await request(app)
      .patch(`${SUBMISSIONS_BASE}/${submission.id}/outcome`)
      .set(H(adminB.token))
      .send({ outcome: 'WON' })
    expect(res.status).toBe(404)
    expect(await eventsOfType(firmB.id, SUBMISSION_OUTCOME_RECORDED)).toHaveLength(0)
  })
})

// =============================================================
// CALIBRATION_UPDATED
// =============================================================

describe('CALIBRATION_UPDATED', () => {
  it('emits exactly one event when a calibration is activated', async () => {
    const calibration = await makeCalibration(firmA.id, 1)
    await activateCalibration(firmA.id, calibration.id, { actorUserId: adminA.id })

    const events = await eventsOfType(firmA.id, CALIBRATION_UPDATED)
    expect(events).toHaveLength(1)
    expect(events[0].entityId).toBe(calibration.id)
    expect((events[0].payload as { reason: string }).reason).toBe('ACTIVATED')
  })

  it('emits nothing for a DRAFT calibration that is never activated', async () => {
    await makeCalibration(firmA.id, 1)
    await makeCalibration(firmA.id, 2)
    expect(await eventsOfType(firmA.id, CALIBRATION_UPDATED)).toHaveLength(0)
  })

  it('records which calibration was replaced', async () => {
    const first = await makeCalibration(firmA.id, 1)
    await activateCalibration(firmA.id, first.id, { actorUserId: adminA.id })
    const second = await makeCalibration(firmA.id, 2)
    await activateCalibration(firmA.id, second.id, { actorUserId: adminA.id })

    const events = await eventsOfType(firmA.id, CALIBRATION_UPDATED)
    expect(events).toHaveLength(2)
    const latest = events.find((e) => e.entityId === second.id)!
    expect((latest.payload as { previousCalibrationId: string }).previousCalibrationId).toBe(first.id)
  })

  it('never rewrites a recorded outcome when calibration changes', async () => {
    const submission = await makeSubmission(firmA, 'WON')
    const calibration = await makeCalibration(firmA.id, 1)
    await activateCalibration(firmA.id, calibration.id, { actorUserId: adminA.id })

    const after = await prisma.submissionRecord.findUniqueOrThrow({ where: { id: submission.id } })
    expect(after.outcome).toBe('WON')
  })

  it('never leaks across a tenant boundary', async () => {
    const calibration = await makeCalibration(firmA.id, 1)
    await activateCalibration(firmA.id, calibration.id, { actorUserId: adminA.id })
    expect(await eventsOfType(firmB.id, CALIBRATION_UPDATED)).toHaveLength(0)
  })
})

// =============================================================
// CONTRACT_AWARDED is reused, not duplicated
// =============================================================

describe('CONTRACT_AWARDED', () => {
  it('is subscribed to by Intelligence and Contract Administration alike', () => {
    const keys = agentsSubscribedTo(CONTRACT_AWARDED).map((d) => d.key)
    expect(keys).toContain('INTELLIGENCE')
    expect(keys).toContain('CONTRACT_ADMINISTRATION')
  })

  it('has exactly ONE emitter in the codebase, in the §7.1 contract module', () => {
    const root = join(__dirname, '..', '..', '..')
    const found: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) { walk(full); continue }
        if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) continue
        const code = readFileSync(full, 'utf8')
        if (/export function emitContractAwarded/.test(code)) found.push(full)
      }
    }
    walk(root)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain(join('agents', 'contract', 'contractEvents.ts'))
  })

  it('defines no second CONTRACT_AWARDED emitter in the intelligence directory', () => {
    for (const file of readdirSync(__dirname).filter((f) => f.endsWith('.ts') && !f.includes('.test.'))) {
      expect(/emitContractAwarded/.test(readFileSync(join(__dirname, file), 'utf8')), file).toBe(false)
    }
  })
})

// =============================================================
// HTTP surface
// =============================================================

describe('intelligence agent HTTP surface', () => {
  it('exposes no endpoint that changes a decision, pursuit, weight or price', async () => {
    const forbidden = [
      '/pursuits/any-id/prioritise',
      '/pursuits/any-id/stage',
      '/decisions/any-id',
      '/weights/apply',
      '/weights/any-id/update',
      '/qualification/thresholds',
      '/pricing/any-id/select',
      '/capabilities/any-id',
      '/calibration/refit',
      '/recommendations/any-id/apply',
      '/apply',
      '/submit',
    ]
    for (const path of forbidden) {
      const res = await request(app).post(`${BASE}${path}`).set(H(adminA.token)).send({})
      expect(res.status, `POST ${BASE}${path} must not exist`).toBe(404)
    }
  })

  it('returns a null analysis before the agent has run', async () => {
    const res = await request(app).get(`${BASE}/portfolio`).set(H(adminA.token))
    expect(res.status).toBe(200)
    expect(res.body.data.intelligence).toBeNull()
    expect(res.body.data.policy.minimumSampleSize).toBe(8)
  })

  it('states the policy a reader can check', async () => {
    const res = await request(app).get(`${BASE}/portfolio`).set(H(adminA.token))
    const notes = res.body.data.policy.notes.join(' ')
    expect(notes).toContain('never 0%')
    expect(notes).toContain('A bid decision is not a result')
    expect(notes).toContain('never enter the win-rate denominator')
    expect(notes).toContain('never presented as a competitor win rate')
    expect(notes).toContain('Another customer’s private data never affects any figure')
  })

  it('rejects an unauthenticated request', async () => {
    expect((await request(app).get(`${BASE}/portfolio`)).status).toBe(401)
  })

  it('never returns another firm’s segments or recommendations', async () => {
    await prisma.winLossSegment.create({
      data: {
        consultingFirmId: firmA.id, segmentType: 'OVERALL', segmentKey: 'OVERALL', segmentLabel: 'All',
        periodStart: new Date(), periodEnd: new Date(), wins: 5, losses: 5, sampleSize: 10,
        minimumSampleSize: 8, dataSufficiency: 'SUFFICIENT', algorithmVersion: 'v1', inputHash: 'h1',
      },
    })
    const res = await request(app).get(`${BASE}/segments`).set(H(adminB.token))
    expect(res.body.data.segments).toHaveLength(0)
  })
})

// =============================================================
// Recommendation dismissal
// =============================================================

describe('recommendation dismissal', () => {
  async function makeRecommendation(firmId: string) {
    return prisma.captureRecommendation.create({
      data: {
        consultingFirmId: firmId, segmentType: 'AGENCY', segmentKey: 'DoD', segmentLabel: 'Department of Defense',
        periodStart: new Date(), periodEnd: new Date(), scoreState: 'SCORED', rank: 1,
        rationale: 'Deterministic rationale.', evidence: { winLoss: { wins: 6, losses: 2 } },
        sampleSize: 8, dataSufficiency: 'SUFFICIENT', status: 'ACTIVE',
        inputHash: uniq('h'), algorithmVersion: 'intelligence-capture-v1',
      },
    })
  }

  it('lets an ADMIN dismiss with a reason', async () => {
    const rec = await makeRecommendation(firmA.id)
    const res = await request(app)
      .post(`${BASE}/recommendations/${rec.id}/dismiss`)
      .set(H(adminA.token))
      .send({ reason: 'Not a focus this year.' })
    expect(res.status).toBe(200)
    expect(res.body.data.recommendation.status).toBe('DISMISSED')
    expect(res.body.data.recommendation.dismissedByUserId).toBe(adminA.id)
  })

  it('requires a reason', async () => {
    const rec = await makeRecommendation(firmA.id)
    expect((await request(app).post(`${BASE}/recommendations/${rec.id}/dismiss`).set(H(adminA.token)).send({})).status).toBe(422)
  })

  it('refuses a non-admin', async () => {
    const rec = await makeRecommendation(firmA.id)
    expect((await request(app).post(`${BASE}/recommendations/${rec.id}/dismiss`).set(H(consultantA.token)).send({ reason: 'x' })).status).toBe(403)
  })

  it('refuses a second dismissal', async () => {
    const rec = await makeRecommendation(firmA.id)
    await request(app).post(`${BASE}/recommendations/${rec.id}/dismiss`).set(H(adminA.token)).send({ reason: 'x' })
    expect((await request(app).post(`${BASE}/recommendations/${rec.id}/dismiss`).set(H(adminA.token)).send({ reason: 'y' })).status).toBe(409)
  })

  it('404s on another firm’s recommendation', async () => {
    const rec = await makeRecommendation(firmA.id)
    const res = await request(app).post(`${BASE}/recommendations/${rec.id}/dismiss`).set(H(adminB.token)).send({ reason: 'x' })
    expect(res.status).toBe(404)
    expect((await prisma.captureRecommendation.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe('ACTIVE')
  })

  it('changes nothing but the recommendation’s own status', async () => {
    const rec = await makeRecommendation(firmA.id)
    const segment = await prisma.winLossSegment.create({
      data: {
        consultingFirmId: firmA.id, segmentType: 'AGENCY', segmentKey: 'DoD', segmentLabel: 'DoD',
        periodStart: new Date(), periodEnd: new Date(), wins: 6, losses: 2, sampleSize: 8,
        minimumSampleSize: 8, dataSufficiency: 'SUFFICIENT', algorithmVersion: 'v1', inputHash: 'seg-h',
      },
    })
    await request(app).post(`${BASE}/recommendations/${rec.id}/dismiss`).set(H(adminA.token)).send({ reason: 'x' })

    const after = await prisma.winLossSegment.findUniqueOrThrow({ where: { id: segment.id } })
    expect(after.wins).toBe(6)
    expect(after.losses).toBe(2)
    expect(after.supersededAt).toBeNull()
  })

  it('audits the dismissal', async () => {
    const rec = await makeRecommendation(firmA.id)
    await request(app).post(`${BASE}/recommendations/${rec.id}/dismiss`).set(H(adminA.token)).send({ reason: 'Out of scope.' })
    const audit = await prisma.auditEvent.findFirst({
      where: { consultingFirmId: firmA.id, entityType: 'CaptureRecommendation', entityId: rec.id },
    })
    expect(audit).not.toBeNull()
    expect(audit!.rationale).toContain('No pursuit, weight or measurement was changed')
  })

  it('lets an admin acknowledge without changing status', async () => {
    const rec = await makeRecommendation(firmA.id)
    const res = await request(app).post(`${BASE}/recommendations/${rec.id}/acknowledge`).set(H(adminA.token)).send({})
    expect(res.status).toBe(200)
    expect((await prisma.captureRecommendation.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe('ACTIVE')
  })

  it('applies the platform read-only policy to team members', async () => {
    // enforceTenantScope makes every non-GET admin-only for CONSULTANT
    // accounts. That is a platform-wide rule this slice does not weaken.
    const rec = await makeRecommendation(firmA.id)
    expect((await request(app).post(`${BASE}/recommendations/${rec.id}/acknowledge`).set(H(consultantA.token)).send({})).status).toBe(403)
  })
})

// =============================================================
// Structural: no prompts, no provider
// =============================================================

describe('intelligence is deterministic by construction', () => {
  const dir = __dirname
  const sourceFiles = () => readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
  const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('imports no LLM router anywhere in the intelligence directory', () => {
    for (const file of sourceFiles()) {
      const code = strip(readFileSync(join(dir, file), 'utf8'))
      expect(/from '.*llm\/llmRouter'/.test(code), file).toBe(false)
      expect(/generateWithRouter/.test(code), file).toBe(false)
    }
  })

  it('defines no system prompt constant anywhere in the intelligence directory', () => {
    for (const file of sourceFiles()) {
      const code = strip(readFileSync(join(dir, file), 'utf8'))
      expect(/SYSTEM_PROMPT|systemPrompt|PROMPT_VERSION/.test(code), file).toBe(false)
    }
  })

  it('contains no prompt file at all', () => {
    expect(readdirSync(dir).filter((f) => /prompt/i.test(f))).toHaveLength(0)
  })

  it('makes no network call', () => {
    for (const file of sourceFiles()) {
      const code = strip(readFileSync(join(dir, file), 'utf8'))
      expect(/axios|fetch\(|node-fetch/.test(code), file).toBe(false)
    }
  })

  it('never writes a decision, pursuit, match, pricing or capability record', () => {
    const forbidden = [
      'bidDecision', 'bidPursuit', 'opportunityMatch', 'qualificationRecommendation',
      'pricingScenario', 'pricingWorkspace', 'firmCapability', 'capabilityNarrative',
      'teamingArrangement', 'proposalSection', 'contractInvoice', 'tenantCalibration',
    ]
    for (const file of sourceFiles()) {
      const code = strip(readFileSync(join(dir, file), 'utf8'))
      for (const model of forbidden) {
        const writes = new RegExp(`${model}\\.(create|createMany|update|updateMany|upsert|delete|deleteMany)`, 'i')
        expect(writes.test(code), `${file} must not write ${model}`).toBe(false)
      }
    }
  })

  it('writes only its own two models plus the shared runtime records', () => {
    const allowed = /^(winLossSegment|captureRecommendation|agentEvent)$/
    for (const file of sourceFiles()) {
      const code = strip(readFileSync(join(dir, file), 'utf8'))
      for (const m of code.matchAll(/(?:prisma|tx)\.([a-zA-Z]+)\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)/g)) {
        expect(allowed.test(m[1]), `${file} writes ${m[1]}, which is not one of its own models`).toBe(true)
      }
    }
  })
})
