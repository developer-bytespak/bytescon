// =============================================================
// §6 — End-to-end integration tests against a real database.
//
// These prove the persistence invariants that unit tests cannot:
//   §6.1A  sync idempotency and honest verification status
//   §6.1B  forecast versioning, and forecasts are never solicitations
//   §6.1G  profile ownership enforced on the BACKEND + alert dedupe
//   §6.3A  extraction never overwrites a verified requirement
//   §6.3F  invalid workflow transitions are rejected
//   §6.4B  amendment revisions are append-only and impacts are proposals
//   §6.4A  the timeline reuses records rather than duplicating them
//   tenant isolation across every new route
// =============================================================
import request from 'supertest'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Express } from 'express'
import {
  buildTestApp,
  createTestFirm,
  createTestUser,
  cleanupFirm,
  type TestFirm,
  type TestUser,
} from '../test-utils/testClient'
import { createTestOpportunity } from '../test-utils/factories'
import { prisma } from '../config/database'
import { runSourceSync } from '../services/discovery/sourceSync'
import { upsertForecast } from '../services/discovery/forecastIngest'
import { runExtraction } from '../services/requirements/extractionPipeline'
import { recordAmendmentRevision } from '../services/milestones/amendmentMonitor'
import { evaluateProfile } from '../services/discovery/profileAlerts'
import type { NormalizedForecast } from '../services/discovery/sourceAdapter'

let app: Express
let firm: TestFirm
let admin: TestUser
let consultant: TestUser
let otherFirm: TestFirm
let otherAdmin: TestUser

const auth = (user: TestUser) => ({ Authorization: `Bearer ${user.token}` })

const forecast = (over: Partial<NormalizedForecast> = {}): NormalizedForecast => ({
  kind: 'FORECAST',
  externalId: 'FY27-TEST-1',
  agency: 'Department of Veterans Affairs',
  title: 'Base operations support services',
  description: 'Anticipated recompete of base operations support.',
  anticipatedSolicitationDate: new Date('2027-01-15T00:00:00Z'),
  anticipatedAwardDate: new Date('2027-06-01T00:00:00Z'),
  fiscalYear: 2027,
  naicsCode: '561210',
  psc: 'S201',
  setAsideExpectation: 'SDVOSB',
  contractVehicle: null,
  estimatedValue: 12_500_000,
  incumbentName: null,
  placeOfPerformance: 'Denver, CO',
  contactName: null, contactEmail: null, contactPhone: null,
  sourceUrl: 'https://va.gov/forecast', sourceReference: 'https://va.gov/forecast.json',
  sourceUpdatedAt: null, sourceMetadata: null,
  dataQuality: 'OK',
  ...over,
})

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm()
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  consultant = await createTestUser(firm.id, { role: 'CONSULTANT' })
  otherFirm = await createTestFirm()
  otherAdmin = await createTestUser(otherFirm.id, { role: 'ADMIN' })
}, 30000)

afterAll(async () => {
  await cleanupFirm(firm.id)
  await cleanupFirm(otherFirm.id)
})

// -------------------------------------------------------------
// §6.1A — sources
// -------------------------------------------------------------

describe('§6.1A — source configuration and sync', () => {
  it('lists the adapter catalogue with verbatim coverage notes', async () => {
    const res = await request(app).get('/api/discovery/adapters').set(auth(admin))
    expect(res.status).toBe(200)
    const keys = res.body.data.map((a: { key: string }) => a.key)
    expect(keys).toEqual(expect.arrayContaining(['sam_gov', 'grants_gov', 'agency_forecast', 'state_local', 'subcontracting_board', 'contract_awards']))
    const stateLocal = res.body.data.find((a: { key: string }) => a.key === 'state_local')
    expect(stateLocal.coverageNote).toMatch(/not, and does not claim to be, national/i)
  })

  it('creates a source and never returns a secret value', async () => {
    const res = await request(app).post('/api/discovery/sources').set(auth(admin)).send({
      adapterKey: 'grants_gov',
      isEnabled: true,
      authEnvKey: 'SOME_OPTIONAL_KEY',
    })
    expect(res.status).toBe(201)
    // Only the NAME of the env var is stored, never a credential.
    expect(res.body.data.authEnvKey).toBe('SOME_OPTIONAL_KEY')
    expect(JSON.stringify(res.body.data)).not.toContain('secret')
    expect(res.body.data.verification).toBe('NOT_CONFIGURED')
  })

  it('rejects an unknown adapter key', async () => {
    const res = await request(app).post('/api/discovery/sources').set(auth(admin)).send({ adapterKey: 'nope' })
    // ValidationError maps to 422 VALIDATION_ERROR in this codebase.
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('VALIDATION_ERROR')
  })

  it('records a SKIPPED run — not a failure — for an unconfigured source', async () => {
    const config = await prisma.opportunitySourceConfig.create({
      data: { consultingFirmId: firm.id, adapterKey: 'state_local', displayName: 'Example State', category: 'STATE_LOCAL', isEnabled: true },
    })
    const outcome = await runSourceSync(firm.id, config.id, { now: new Date('2026-06-01T00:00:00Z') })
    expect(outcome.status).toBe('SKIPPED')
    const after = await prisma.opportunitySourceConfig.findUnique({ where: { id: config.id } })
    // Never promoted to live when nothing was actually fetched.
    expect(after?.verification).toBe('NOT_CONFIGURED')
    expect(after?.dataQuality).toBe('UNVERIFIED')
  })

  it('is idempotent: the same key twice produces one run, not two', async () => {
    const config = await prisma.opportunitySourceConfig.create({
      data: { consultingFirmId: firm.id, adapterKey: 'subcontracting_board', displayName: 'Board', category: 'SUBCONTRACTING_BOARD', isEnabled: true },
    })
    const now = new Date('2026-06-01T10:00:00Z')
    const first = await runSourceSync(firm.id, config.id, { now })
    const second = await runSourceSync(firm.id, config.id, { now })
    expect(second.skipped).toBe(true)
    expect(second.runId).toBe(first.runId)
    const runs = await prisma.sourceSyncRun.count({ where: { sourceConfigId: config.id } })
    expect(runs).toBe(1)
  })

  it('does not expose another firm’s sources', async () => {
    const res = await request(app).get('/api/discovery/sources').set(auth(otherAdmin))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(0)
  })
})

// -------------------------------------------------------------
// §6.1B — forecasts
// -------------------------------------------------------------

describe('§6.1B — agency forecasts', () => {
  it('creates, then versions a forecast when a field changes', async () => {
    const now = new Date('2026-06-01T00:00:00Z')
    expect(await upsertForecast(firm.id, null, forecast(), now)).toBe('created')
    // Re-seeing identical content must not create a version.
    expect(await upsertForecast(firm.id, null, forecast(), now)).toBe('unchanged')
    // A moved solicitation date is a material change.
    expect(await upsertForecast(firm.id, null, forecast({ anticipatedSolicitationDate: new Date('2027-03-01T00:00:00Z') }), now)).toBe('updated')

    const stored = await prisma.agencyForecast.findUnique({
      where: { consultingFirmId_externalId: { consultingFirmId: firm.id, externalId: 'FY27-TEST-1' } },
      include: { versions: true },
    })
    expect(stored?.versions).toHaveLength(1)
    // The PRIOR value is preserved in history.
    expect((stored!.versions[0].snapshot as Record<string, unknown>).anticipatedSolicitationDate).toContain('2027-01-15')
    expect(stored!.versions[0].changedKeys).toContain('anticipatedSolicitationDate')
  })

  it('returns forecasts labelled as forecasts, never as solicitations', async () => {
    const res = await request(app).get('/api/discovery/forecasts').set(auth(admin))
    expect(res.status).toBe(200)
    expect(res.body.data.recordKind).toBe('FORECAST')
    expect(res.body.data.disclaimer).toMatch(/not released solicitations/i)
    expect(res.body.data.items[0].linkState).toBe('UNLINKED')
  })

  it('does not create an Opportunity row for a forecast', async () => {
    const opportunities = await prisma.opportunity.findMany({ where: { consultingFirmId: firm.id, title: 'Base operations support services' } })
    expect(opportunities).toHaveLength(0)
  })

  it('supports filtering by agency, NAICS and fiscal year', async () => {
    const match = await request(app).get('/api/discovery/forecasts?agency=Veterans&naicsCode=5612&fiscalYear=2027').set(auth(admin))
    expect(match.body.data.items.length).toBeGreaterThan(0)
    const miss = await request(app).get('/api/discovery/forecasts?agency=NASA').set(auth(admin))
    expect(miss.body.data.items).toHaveLength(0)
  })

  it('does not leak forecasts across firms', async () => {
    const res = await request(app).get('/api/discovery/forecasts').set(auth(otherAdmin))
    expect(res.body.data.items).toHaveLength(0)
  })
})

// -------------------------------------------------------------
// §6.1G — saved profile ownership + alerts
// -------------------------------------------------------------

describe('§6.1G — profile ownership and visibility, enforced on the backend', () => {
  // NOTE ON THE ROLE ARCHITECTURE (§6.1G explicitly allows for this):
  // this platform's `enforceTenantScope` middleware makes CONSULTANT accounts
  // read-only across EVERY tenant-scoped route — it is a deliberate,
  // separately-tested platform contract, not a UI convenience. §6.1G says a
  // CONSULTANT may manage their own profiles "unless current role architecture
  // intentionally forbids it", and here it does. So the safe permission model
  // implemented is: writes follow the existing role contract, and ownership +
  // PRIVATE visibility are enforced server-side on top of it — never by hiding
  // anything in the frontend. These tests pin both halves of that.
  let adminProfileId: string

  it('keeps CONSULTANT accounts read-only, per the platform role contract', async () => {
    const res = await request(app).post('/api/monitoring-profiles').set(auth(consultant)).send({
      name: `Consultant attempt ${Date.now()}`, filters: { naicsCode: '5415' },
    })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('FORBIDDEN')
    expect(res.body.error).toMatch(/read-only access/i)
  })

  it('assigns ownership to the creating user', async () => {
    const res = await request(app).post('/api/monitoring-profiles').set(auth(admin)).send({
      name: `Owned by admin ${Date.now()}`, visibility: 'PRIVATE',
      alertFrequency: 'DAILY', priority: 'HIGH', filters: { naicsCode: '5415' },
    })
    expect(res.status).toBe(201)
    expect(res.body.data.ownerUserId).toBe(admin.id)
    expect(res.body.data.visibility).toBe('PRIVATE')
    // Setting a cadence schedules the next evaluation immediately.
    expect(res.body.data.nextEvaluationAt).toBeTruthy()
    adminProfileId = res.body.data.id
  })

  it('hides a PRIVATE profile from a non-owner on read', async () => {
    const list = await request(app).get('/api/monitoring-profiles').set(auth(consultant))
    expect(list.status).toBe(200)
    expect(list.body.data.find((p: { id: string }) => p.id === adminProfileId)).toBeUndefined()

    const detail = await request(app).get(`/api/monitoring-profiles/${adminProfileId}`).set(auth(consultant))
    expect(detail.status).toBe(404)
  })

  it('shows a FIRM-visible profile to everyone in the firm', async () => {
    const created = await request(app).post('/api/monitoring-profiles').set(auth(admin)).send({
      name: `Shared ${Date.now()}`, visibility: 'FIRM', filters: { naicsCode: '5415' },
    })
    expect(created.status).toBe(201)
    const detail = await request(app).get(`/api/monitoring-profiles/${created.body.data.id}`).set(auth(consultant))
    expect(detail.status).toBe(200)
  })

  it('lets the owner update their own profile', async () => {
    const res = await request(app).put(`/api/monitoring-profiles/${adminProfileId}`).set(auth(admin)).send({ priority: 'CRITICAL' })
    expect(res.status).toBe(200)
    expect(res.body.data.priority).toBe('CRITICAL')
  })

  it('does not expose a profile across firms', async () => {
    const res = await request(app).get(`/api/monitoring-profiles/${adminProfileId}`).set(auth(otherAdmin))
    expect(res.status).toBe(404)
  })

  it('deduplicates alerts: a second evaluation of unchanged records adds nothing', async () => {
    const opportunity = await createTestOpportunity(firm.id, {
      title: 'Cyber support services', naicsCode: '541512',
      responseDeadline: new Date(Date.now() + 30 * 86400000),
    })
    const profile = await prisma.savedMonitoringProfile.create({
      data: {
        consultingFirmId: firm.id, name: `Dedupe ${Date.now()}`, ownerUserId: admin.id,
        alertFrequency: 'INSTANT', isActive: true, filters: { naicsCode: '5415' },
      },
    })

    const first = await evaluateProfile(profile.id)
    expect(first.newAlerts).toBeGreaterThan(0)

    const second = await evaluateProfile(profile.id)
    expect(second.newAlerts).toBe(0)
    expect(second.reAlerts).toBe(0)
    expect(second.suppressed).toBeGreaterThan(0)

    const alerts = await prisma.monitoringProfileAlert.count({ where: { profileId: profile.id } })
    expect(alerts).toBe(first.newAlerts)
    expect(opportunity.id).toBeTruthy()
  })

  it('re-alerts only after a meaningful change', async () => {
    const opportunity = await createTestOpportunity(firm.id, {
      title: 'Logistics support', naicsCode: '488510',
      responseDeadline: new Date(Date.now() + 40 * 86400000),
    })
    const profile = await prisma.savedMonitoringProfile.create({
      data: {
        consultingFirmId: firm.id, name: `Change ${Date.now()}`, ownerUserId: admin.id,
        alertFrequency: 'INSTANT', isActive: true, filters: { naicsCode: '4885' },
      },
    })
    await evaluateProfile(profile.id)
    // A cosmetic edit must NOT re-alert.
    await prisma.opportunity.update({ where: { id: opportunity.id }, data: { title: 'Logistics support (revised title)' } })
    expect((await evaluateProfile(profile.id)).reAlerts).toBe(0)
    // A moved deadline is material.
    await prisma.opportunity.update({ where: { id: opportunity.id }, data: { responseDeadline: new Date(Date.now() + 20 * 86400000) } })
    expect((await evaluateProfile(profile.id)).reAlerts).toBe(1)
  })
})

// -------------------------------------------------------------
// §6.3A / §6.3F — extraction and requirement workflow
// -------------------------------------------------------------

describe('§6.3A — extraction never overwrites verified human data', () => {
  const TEXT = `SECTION L INSTRUCTIONS
L.1 The offeror shall submit a technical volume not to exceed 30 pages.
L.2 Proposals must be received no later than 03/15/2027.
SECTION M EVALUATION
M.1 The Government will evaluate the technical volume for completeness.
FAR 52.204-7 System for Award Management. The Contractor shall insert the substance of this clause in all subcontracts.`

  let opportunityId: string

  it('extracts requirements, clauses and milestones into the existing matrix', async () => {
    const opportunity = await createTestOpportunity(firm.id, { title: 'Extraction target', naicsCode: '541512' })
    opportunityId = opportunity.id

    const outcome = await runExtraction({ consultingFirmId: firm.id, opportunityId, text: TEXT })
    expect(['SUCCEEDED', 'PARTIAL']).toContain(outcome.status)
    expect(outcome.requirementsCreated).toBeGreaterThan(0)
    expect(outcome.clausesCreated).toBeGreaterThan(0)

    // ONE compliance matrix — the existing model, not a second one.
    const matrices = await prisma.complianceMatrix.count({ where: { opportunityId } })
    expect(matrices).toBe(1)
  })

  it('never marks an extracted requirement verified', async () => {
    const matrix = await prisma.complianceMatrix.findUnique({ where: { opportunityId }, select: { id: true } })
    const requirements = await prisma.matrixRequirement.findMany({ where: { matrixId: matrix!.id } })
    expect(requirements.length).toBeGreaterThan(0)
    expect(requirements.every((r) => r.isManuallyVerified === false)).toBe(true)
    expect(requirements.every((r) => r.verificationStatus === 'UNVERIFIED')).toBe(true)
  })

  it('is idempotent — re-running the same document creates no duplicates', async () => {
    const matrix = await prisma.complianceMatrix.findUnique({ where: { opportunityId }, select: { id: true } })
    const before = await prisma.matrixRequirement.count({ where: { matrixId: matrix!.id } })
    const rerun = await runExtraction({ consultingFirmId: firm.id, opportunityId, text: TEXT })
    expect(rerun.alreadyProcessed).toBe(true)
    const after = await prisma.matrixRequirement.count({ where: { matrixId: matrix!.id } })
    expect(after).toBe(before)
  })

  it('preserves a human-verified requirement across reprocessing', async () => {
    const matrix = await prisma.complianceMatrix.findUnique({ where: { opportunityId }, select: { id: true } })
    const target = await prisma.matrixRequirement.findFirst({ where: { matrixId: matrix!.id } })
    await prisma.matrixRequirement.update({
      where: { id: target!.id },
      data: { isManuallyVerified: true, verificationStatus: 'VERIFIED', requirementText: 'HUMAN EDITED TEXT', status: 'VERIFIED' },
    })

    // Reprocess with slightly different content so a new job actually runs.
    await runExtraction({ consultingFirmId: firm.id, opportunityId, text: `${TEXT}\nL.3 The offeror shall provide a signed SF-33 form.`, isAmendmentReprocess: true })

    const after = await prisma.matrixRequirement.findUnique({ where: { id: target!.id } })
    expect(after?.requirementText).toBe('HUMAN EDITED TEXT')
    expect(after?.isManuallyVerified).toBe(true)
  })

  it('exposes L/M coverage including unmapped items and gaps', async () => {
    const res = await request(app).get(`/api/requirements-intel/lm/${opportunityId}`).set(auth(admin))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveProperty('instructions')
    expect(res.body.data).toHaveProperty('unmappedEvaluations')
    expect(Array.isArray(res.body.data.gaps)).toBe(true)
  })

  it('renders the legal-review disclaimer with clause obligations', async () => {
    const res = await request(app).get(`/api/requirements-intel/clauses/${opportunityId}`).set(auth(admin))
    expect(res.status).toBe(200)
    expect(res.body.data.disclaimer).toMatch(/legal review required/i)
    expect(res.body.data.disclaimer).toMatch(/not legal counsel/i)
    const far = res.body.data.clauses.find((c: { clauseNumber: string }) => c.clauseNumber === '52.204-7')
    expect(far.flowDownStatus).toBe('EXPLICIT_FLOWDOWN')
    expect(far.legalReviewRequired).toBe(true)
  })

  it('rejects an invalid workflow transition', async () => {
    const matrix = await prisma.complianceMatrix.findUnique({ where: { opportunityId }, select: { id: true } })
    const target = await prisma.matrixRequirement.findFirst({ where: { matrixId: matrix!.id, status: 'NOT_STARTED' } })
    // NOT_STARTED → COMPLETE skips the workflow and must be refused.
    const res = await request(app).post(`/api/requirements-intel/requirements/${target!.id}/transition`).set(auth(admin)).send({ toStatus: 'COMPLETE' })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/Cannot move a requirement from NOT_STARTED to COMPLETE/)
  })

  it('accepts a valid transition and records history', async () => {
    const matrix = await prisma.complianceMatrix.findUnique({ where: { opportunityId }, select: { id: true } })
    const target = await prisma.matrixRequirement.findFirst({ where: { matrixId: matrix!.id, status: 'NOT_STARTED' } })
    const res = await request(app).post(`/api/requirements-intel/requirements/${target!.id}/transition`).set(auth(admin)).send({ toStatus: 'IN_PROGRESS' })
    expect(res.status).toBe(200)
    const events = await prisma.matrixRequirementEvent.findMany({ where: { requirementId: target!.id } })
    expect(events.some((e) => e.action === 'STATUS_CHANGE' && e.toValue === 'IN_PROGRESS')).toBe(true)
  })

  it('refuses to assign a requirement to a user from another firm', async () => {
    const matrix = await prisma.complianceMatrix.findUnique({ where: { opportunityId }, select: { id: true } })
    const target = await prisma.matrixRequirement.findFirst({ where: { matrixId: matrix!.id } })
    const res = await request(app).post(`/api/requirements-intel/requirements/${target!.id}/assign`).set(auth(admin)).send({ ownerUserId: otherAdmin.id })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/member of your firm/i)
  })
})

// -------------------------------------------------------------
// §6.4B — amendments
// -------------------------------------------------------------

describe('§6.4B — amendment revisions are append-only and impacts are proposals', () => {
  let opportunityId: string

  it('records a revision with a content hash', async () => {
    const opportunity = await createTestOpportunity(firm.id, { title: 'Amendment target', naicsCode: '541512' })
    opportunityId = opportunity.id
    const result = await recordAmendmentRevision({
      consultingFirmId: firm.id, opportunityId,
      amendmentNumber: '0001',
      text: 'SECTION L\nL.1 Proposals must be received no later than 04/15/2027.\nFAR 52.204-7 System for Award Management.',
    })
    expect(result.isNew).toBe(true)
    expect(result.revisionNo).toBe(1)
    // Every amendment requires human review; it is never auto-cleared.
    const stored = await prisma.amendmentRevision.findUnique({ where: { id: result.revisionId! } })
    expect(stored?.humanReviewRequired).toBe(true)
    expect(stored?.contentHash).toHaveLength(64)
  })

  it('never stores the same content twice', async () => {
    const text = 'SECTION L\nL.1 Proposals must be received no later than 04/15/2027.\nFAR 52.204-7 System for Award Management.'
    const again = await recordAmendmentRevision({ consultingFirmId: firm.id, opportunityId, text })
    expect(again.isNew).toBe(false)
    expect(await prisma.amendmentRevision.count({ where: { opportunityId } })).toBe(1)
  })

  it('creates impacts as proposals that mutate nothing', async () => {
    const impacts = await prisma.amendmentImpact.findMany({ where: { opportunityId } })
    expect(impacts.length).toBeGreaterThan(0)
    expect(impacts.every((i) => i.reviewRequired)).toBe(true)
    expect(impacts.every((i) => i.acknowledgedAt === null)).toBe(true)
    expect(impacts.some((i) => i.area === 'CLAUSE')).toBe(true)
  })

  it('acknowledges a revision and its impacts', async () => {
    const revision = await prisma.amendmentRevision.findFirst({ where: { opportunityId } })
    const res = await request(app).post(`/api/milestones/amendments/revision/${revision!.id}/acknowledge`).set(auth(admin)).send({})
    expect(res.status).toBe(200)
    const after = await prisma.amendmentRevision.findUnique({ where: { id: revision!.id } })
    expect(after?.acknowledgedByUserId).toBe(admin.id)
  })

  it('does not expose another firm’s amendment revisions', async () => {
    const res = await request(app).get(`/api/milestones/amendments/${opportunityId}`).set(auth(otherAdmin))
    expect(res.body.data.revisions).toHaveLength(0)
  })
})

// -------------------------------------------------------------
// §6.4A — timeline
// -------------------------------------------------------------

describe('§6.4A — the timeline reuses existing records', () => {
  it('derives a milestone from the opportunity deadline without duplicating it', async () => {
    const deadline = new Date(Date.now() + 45 * 86400000)
    const opportunity = await createTestOpportunity(firm.id, { title: 'Timeline target', responseDeadline: deadline })

    const res = await request(app).get(`/api/milestones/timeline/${opportunity.id}`).set(auth(admin))
    expect(res.status).toBe(200)
    const proposalDeadline = res.body.data.items.find((m: { milestoneType: string }) => m.milestoneType === 'PROPOSAL_DEADLINE')
    expect(proposalDeadline).toBeDefined()
    expect(proposalDeadline.origin).toBe('SYSTEM')
    expect(new Date(proposalDeadline.endAt).toISOString()).toBe(deadline.toISOString())

    // A second sync must refresh, not duplicate.
    await request(app).get(`/api/milestones/timeline/${opportunity.id}`).set(auth(admin))
    const count = await prisma.opportunityMilestone.count({
      where: { opportunityId: opportunity.id, milestoneType: 'PROPOSAL_DEADLINE' },
    })
    expect(count).toBe(1)
  })

  it('buckets milestones into upcoming / overdue / at-risk', async () => {
    const opportunity = await createTestOpportunity(firm.id, { title: 'Bucket target' })
    const res = await request(app).get(`/api/milestones/timeline/${opportunity.id}`).set(auth(admin))
    expect(res.body.data.buckets).toHaveProperty('upcoming')
    expect(res.body.data.buckets).toHaveProperty('overdue')
    expect(res.body.data.buckets).toHaveProperty('atRisk')
  })

  it('exports a standards-compliant ICS calendar', async () => {
    const res = await request(app).get('/api/milestones/calendar.ics').set(auth(admin))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/calendar')
    expect(res.text).toContain('BEGIN:VCALENDAR')
    expect(res.text).toContain('END:VCALENDAR')
    expect(res.text).toContain('\r\n')
  })

  it('refuses a milestone on another firm’s opportunity', async () => {
    const opportunity = await createTestOpportunity(firm.id, { title: 'Cross tenant' })
    const res = await request(app).post('/api/milestones').set(auth(otherAdmin)).send({
      opportunityId: opportunity.id, milestoneType: 'CUSTOM', title: 'Sneaky',
    })
    expect(res.status).toBe(404)
  })
})

// -------------------------------------------------------------
// §6.2 — scoring intelligence
// -------------------------------------------------------------

describe('§6.2 — scoring intelligence', () => {
  it('returns a transparent score with factors, calibration state and an interval', async () => {
    const opportunity = await createTestOpportunity(firm.id, { title: 'Scored', probabilityScore: 0.42, isScored: true })
    const res = await request(app).get(`/api/scoring-intel/score/${opportunity.id}`).set(auth(admin))
    expect(res.status).toBe(200)

    const data = res.body.data
    expect(data).toHaveProperty('rawScore')
    expect(data).toHaveProperty('finalScore')
    expect(Array.isArray(data.factors)).toBe(true)
    expect(data.calibration.applied).toBe('NONE')
    // A brand-new firm has no outcomes, so no interval may be claimed.
    expect(data.interval.available).toBe(false)
    expect(data.interval.unavailableLabel).toBe('INSUFFICIENT DATA — INTERVAL NOT AVAILABLE')
    expect(data.explanation).toMatch(/not a prediction of the award/i)
  })

  it('reports calibration status honestly for a firm with no outcomes', async () => {
    const res = await request(app).get('/api/scoring-intel/calibration').set(auth(admin))
    expect(res.status).toBe(200)
    expect(res.body.data.active).toBeNull()
    expect(res.body.data.verifiedSampleCount).toBe(0)
  })

  it('returns a portfolio with its documented value hierarchy and exclusions', async () => {
    await createTestOpportunity(firm.id, { title: 'Valued', estimatedValue: 1_000_000, probabilityScore: 0.5, isScored: true })
    // Created directly: the factory always supplies a value, and this row must
    // genuinely have none so the exclusion path is exercised.
    await prisma.opportunity.create({
      data: {
        consultingFirmId: firm.id, title: 'No value at all', agency: 'GSA', naicsCode: '541330',
        responseDeadline: new Date(Date.now() + 30 * 86400000), probabilityScore: 0.5, isScored: true,
        estimatedValue: null, estimatedValueMin: null, estimatedValueMax: null,
      },
    })

    const res = await request(app).get('/api/scoring-intel/portfolio').set(auth(admin))
    expect(res.status).toBe(200)
    const data = res.body.data
    expect(data.valueHierarchy.length).toBeGreaterThan(0)
    expect(data.weightedExpectedValue).toBeGreaterThan(0)
    // Rows without a value are excluded and REPORTED, never counted as zero.
    expect(data.exclusions.some((e: { title: string }) => e.title === 'No value at all')).toBe(true)
    expect(data.byValueType).toHaveProperty('ESTIMATED')
  })

  it('exports the portfolio as CSV including excluded rows', async () => {
    const res = await request(app).get('/api/scoring-intel/portfolio/export').set(auth(admin))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.text).toContain('Expected Value')
    expect(res.text).toContain('EXCLUDED')
  })

  it('returns competitor stats with the exact basis labels', async () => {
    const res = await request(app).get('/api/scoring-intel/competitors').set(auth(admin))
    expect(res.status).toBe(200)
    expect(res.body.data.basisLabels.OBSERVED_AWARD_SHARE).toBe('Observed award share')
    expect(res.body.data.basisLabels.INSUFFICIENT_DATA).toBe('Bid-participation data unavailable')
    expect(res.body.data.note).toMatch(/never as a win rate/i)
  })

  it('does not expose another firm’s score', async () => {
    const opportunity = await createTestOpportunity(firm.id, { title: 'Private score' })
    const res = await request(app).get(`/api/scoring-intel/score/${opportunity.id}`).set(auth(otherAdmin))
    expect(res.status).toBe(404)
  })
})

// -------------------------------------------------------------
// §6.3D / §6.3E — documents and validation
// -------------------------------------------------------------

describe('§6.3D/§6.3E — document library and validation', () => {
  it('publishes the validation catalogue, including unsupported checks', async () => {
    const res = await request(app).get('/api/requirements-intel/validation/catalogue').set(auth(admin))
    expect(res.status).toBe(200)
    const docx = res.body.data.find((c: { key: string }) => c.key === 'DOCX_PAGE_COUNT')
    // Honest: the platform states what it cannot verify.
    expect(docx.automatable).toBe(false)
    expect(docx.note).toMatch(/no reliable page count/i)
    const signature = res.body.data.find((c: { key: string }) => c.key === 'SIGNATURE_PRESENT')
    expect(signature.automatable).toBe(false)
  })

  it('references existing certification records rather than copying files', async () => {
    await prisma.certification.create({
      data: { consultingFirmId: firm.id, name: 'SDVOSB', category: 'SET_ASIDE', expiryDate: new Date('2028-01-01') },
    })
    const sync = await request(app).post('/api/requirements-intel/documents/sync').set(auth(admin)).send({})
    expect(sync.status).toBe(200)
    expect(sync.body.data.note).toMatch(/referenced, not copied/i)

    const docs = await prisma.standingDocument.findMany({ where: { consultingFirmId: firm.id, sourceSystem: 'CERTIFICATION' } })
    expect(docs.length).toBeGreaterThan(0)
    expect(docs[0].relatedCertificationId).toBeTruthy()
  })

  it('lists library health with expiry state labels', async () => {
    const res = await request(app).get('/api/requirements-intel/documents').set(auth(admin))
    expect(res.status).toBe(200)
    expect(res.body.data.expiryLabels).toHaveProperty('EXPIRES_BEFORE_SUBMISSION')
    expect(res.body.data.documents.length).toBeGreaterThan(0)
  })

  it('does not expose another firm’s documents', async () => {
    const res = await request(app).get('/api/requirements-intel/documents').set(auth(otherAdmin))
    expect(res.body.data.documents).toHaveLength(0)
  })
})

// -------------------------------------------------------------
// Auth
// -------------------------------------------------------------

describe('§6 — every new route requires authentication', () => {
  const endpoints = [
    '/api/discovery/sources',
    '/api/discovery/forecasts',
    '/api/discovery/recompetes',
    '/api/discovery/capabilities',
    '/api/scoring-intel/portfolio',
    '/api/scoring-intel/calibration',
    '/api/requirements-intel/documents',
    '/api/requirements-intel/validation/catalogue',
    '/api/milestones/calendar',
    '/api/milestones/holidays',
  ]

  it.each(endpoints)('rejects an unauthenticated request to %s', async (endpoint) => {
    const res = await request(app).get(endpoint)
    expect(res.status).toBe(401)
  })
})
