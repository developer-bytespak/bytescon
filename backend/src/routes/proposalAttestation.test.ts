// =============================================================
// FIX-6 — human-in-the-loop attestation on AI-drafted proposals.
// Covers: status, the confirmed:true gate, recording, staleness on
// draft change, the gated final-PDF export, and cross-tenant 404.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import { prisma } from '../config/database'
import {
  buildTestApp,
  createTestFirm,
  createTestUser,
  cleanupFirm,
  disconnectDb,
  TestFirm,
  TestUser,
} from '../test-utils/testClient'

let app: Express
let firm: TestFirm
let admin: TestUser
let otherFirm: TestFirm
let otherAdmin: TestUser

const DRAFT = {
  opportunityTitle: 'Cyber Support Services',
  agency: 'DHS',
  preparedDate: '2026-07-01',
  sections: [
    { title: 'Technical Approach', content: 'Our approach delivers zero-trust security engineering across the enterprise.' },
    { title: 'Past Performance', content: 'We have delivered comparable SOC operations on three prior federal contracts.' },
  ],
}

async function makeOppWithDraft(firmId: string, draft: unknown = DRAFT) {
  return prisma.opportunity.create({
    data: {
      consultingFirmId: firmId,
      title: 'Cyber Support Services',
      agency: 'DHS',
      naicsCode: '541512',
      responseDeadline: new Date(Date.now() + 20 * 86_400_000),
      savedProposalDraft: draft as object,
      savedProposalPdfKey: 'proposal_seed.pdf',
      savedProposalDraftAt: new Date(),
    },
  })
}

// Review-what-you-attest flow: fetch the displayed draft's hash, echo it back.
async function attestCurrent(oppId: string, token: string) {
  const status = await request(app)
    .get(`/api/proposal-assist/${oppId}/attestation`)
    .set('Authorization', `Bearer ${token}`)
  return request(app)
    .post(`/api/proposal-assist/${oppId}/attest`)
    .set('Authorization', `Bearer ${token}`)
    .send({ confirmed: true, draftContentHash: status.body.data.draftContentHash })
}

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Attest Firm A' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  otherFirm = await createTestFirm({ name: 'Attest Firm B' })
  otherAdmin = await createTestUser(otherFirm.id, { role: 'ADMIN' })
})

afterAll(async () => {
  await cleanupFirm(firm.id)
  await cleanupFirm(otherFirm.id)
  await disconnectDb()
})

describe('FIX-6 proposal attestation — /api/proposal-assist/:id/{attestation,attest,final-pdf}', () => {
  it('reports unattested status with the statement to affirm', async () => {
    const opp = await makeOppWithDraft(firm.id)
    const res = await request(app)
      .get(`/api/proposal-assist/${opp.id}/attestation`)
      .set('Authorization', `Bearer ${admin.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.hasDraft).toBe(true)
    expect(res.body.data.attested).toBe(false)
    expect(res.body.data.statement).toMatch(/professional responsibility/i)
    expect(res.body.data.statementVersion).toBeTruthy()
  })

  it('rejects attesting without confirmed:true (422)', async () => {
    const opp = await makeOppWithDraft(firm.id)
    const res = await request(app)
      .post(`/api/proposal-assist/${opp.id}/attest`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ confirmed: false })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('ATTESTATION_NOT_CONFIRMED')
  })

  it('blocks the final export until attested (403 ATTESTATION_REQUIRED)', async () => {
    const opp = await makeOppWithDraft(firm.id)
    const res = await request(app)
      .get(`/api/proposal-assist/${opp.id}/final-pdf`)
      .set('Authorization', `Bearer ${admin.token}`)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ATTESTATION_REQUIRED')
  })

  it('rejects attesting without the reviewed draft hash (422) and with an outdated hash (409)', async () => {
    const opp = await makeOppWithDraft(firm.id)

    const noHash = await request(app)
      .post(`/api/proposal-assist/${opp.id}/attest`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ confirmed: true })
    expect(noHash.status).toBe(422)
    expect(noHash.body.code).toBe('ATTESTATION_HASH_REQUIRED')

    // Reviewer loaded the panel, then the draft was regenerated (second tab /
    // colleague) before they clicked Attest — the click must NOT pin the new,
    // unreviewed draft.
    const status = await request(app)
      .get(`/api/proposal-assist/${opp.id}/attestation`)
      .set('Authorization', `Bearer ${admin.token}`)
    const reviewedHash = status.body.data.draftContentHash
    expect(reviewedHash).toBeTruthy()

    await prisma.opportunity.update({
      where: { id: opp.id },
      data: {
        savedProposalDraft: {
          ...DRAFT,
          sections: [{ title: 'Technical Approach', content: 'Regenerated content the reviewer never saw.' }],
        } as object,
      },
    })

    const staleClick = await request(app)
      .post(`/api/proposal-assist/${opp.id}/attest`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ confirmed: true, draftContentHash: reviewedHash })
    expect(staleClick.status).toBe(409)
    expect(staleClick.body.code).toBe('DRAFT_CHANGED_SINCE_REVIEW')
  })

  it('records an attestation and then serves a human-reviewed final PDF', async () => {
    const opp = await makeOppWithDraft(firm.id)

    const attest = await attestCurrent(opp.id, admin.token)
    expect(attest.status).toBe(200)
    expect(attest.body.data.attestedByName).toBeTruthy()

    const status = await request(app)
      .get(`/api/proposal-assist/${opp.id}/attestation`)
      .set('Authorization', `Bearer ${admin.token}`)
    expect(status.body.data.attested).toBe(true)
    expect(status.body.data.isStale).toBe(false)

    const pdf = await request(app)
      .get(`/api/proposal-assist/${opp.id}/final-pdf`)
      .set('Authorization', `Bearer ${admin.token}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => cb(null, Buffer.concat(chunks)))
      })
    expect(pdf.status).toBe(200)
    expect(pdf.headers['content-type']).toContain('application/pdf')
    expect((pdf.body as Buffer).slice(0, 4).toString()).toBe('%PDF')
  })

  it('goes stale when the draft changes, blocking the final export (403 ATTESTATION_STALE)', async () => {
    const opp = await makeOppWithDraft(firm.id)
    await attestCurrent(opp.id, admin.token)

    // Regenerate/edit the draft — content hash now diverges from the attestation.
    await prisma.opportunity.update({
      where: { id: opp.id },
      data: {
        savedProposalDraft: {
          ...DRAFT,
          sections: [{ title: 'Technical Approach', content: 'A materially different, edited approach section.' }],
        } as object,
      },
    })

    const status = await request(app)
      .get(`/api/proposal-assist/${opp.id}/attestation`)
      .set('Authorization', `Bearer ${admin.token}`)
    expect(status.body.data.isStale).toBe(true)
    expect(status.body.data.attested).toBe(false)

    const pdf = await request(app)
      .get(`/api/proposal-assist/${opp.id}/final-pdf`)
      .set('Authorization', `Bearer ${admin.token}`)
    expect(pdf.status).toBe(403)
    expect(pdf.body.code).toBe('ATTESTATION_STALE')
  })

  it('summarizes per-section confidence with LOW-first flagged sections', async () => {
    const opp = await makeOppWithDraft(firm.id, {
      ...DRAFT,
      sections: [
        { title: 'Executive Summary', content: 'Well-grounded summary of the requirement.', confidence: 'HIGH' },
        { title: 'Staffing Plan', content: 'Partially inferred staffing structure.', confidence: 'MEDIUM' },
        { title: 'Past Performance', content: 'Thin inputs; placeholders used throughout.', confidence: 'LOW' },
        { title: 'Price Approach', content: 'Section from before confidence flags shipped.' },
      ],
    })
    const res = await request(app)
      .get(`/api/proposal-assist/${opp.id}/attestation`)
      .set('Authorization', `Bearer ${admin.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.confidence).toEqual({ high: 1, medium: 1, low: 1, unrated: 1 })
    expect(res.body.data.flaggedSections).toEqual([
      { title: 'Past Performance', confidence: 'LOW' },
      { title: 'Staffing Plan', confidence: 'MEDIUM' },
    ])
  })

  it('does NOT go stale when only confidence flags change (hash covers title + content only)', async () => {
    const opp = await makeOppWithDraft(firm.id)
    await attestCurrent(opp.id, admin.token)

    // Same titles + contents, confidence annotations added — e.g. an older
    // draft re-saved by newer code. The attestation must survive.
    await prisma.opportunity.update({
      where: { id: opp.id },
      data: {
        savedProposalDraft: {
          ...DRAFT,
          sections: DRAFT.sections.map((s) => ({ ...s, confidence: 'HIGH' })),
        } as object,
      },
    })

    const status = await request(app)
      .get(`/api/proposal-assist/${opp.id}/attestation`)
      .set('Authorization', `Bearer ${admin.token}`)
    expect(status.body.data.isStale).toBe(false)
    expect(status.body.data.attested).toBe(true)
  })

  it("404s on another firm's opportunity", async () => {
    const opp = await makeOppWithDraft(otherFirm.id)
    const res = await request(app)
      .get(`/api/proposal-assist/${opp.id}/attestation`)
      .set('Authorization', `Bearer ${admin.token}`)
    expect(res.status).toBe(404)
    // And the other firm's own admin can reach it.
    const ok = await request(app)
      .get(`/api/proposal-assist/${opp.id}/attestation`)
      .set('Authorization', `Bearer ${otherAdmin.token}`)
    expect(ok.status).toBe(200)
  })
})
