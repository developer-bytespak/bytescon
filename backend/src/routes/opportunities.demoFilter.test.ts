// =============================================================
// Section 4 #2 — GET /api/opportunities hides seeded demo rows by default and
// returns them (labeled via isDemo) only when includeDemo=true. Live rows are
// always visible and never accidentally classified as demo.
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

const future = () => new Date(Date.now() + 30 * 86_400_000)

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Demo Filter Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })

  // A live, real-source opportunity (32-char hex notice id).
  await prisma.opportunity.create({
    data: {
      consultingFirmId: firm.id,
      title: 'Live Opportunity',
      agency: 'GSA',
      naicsCode: '541512',
      responseDeadline: future(),
      samNoticeId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      isDemo: false,
    },
  })

  // A seeded demo opportunity (no real notice id).
  await prisma.opportunity.create({
    data: {
      consultingFirmId: firm.id,
      title: 'Seeded Demo Opportunity',
      agency: 'VA',
      naicsCode: '484121',
      responseDeadline: future(),
      isDemo: true,
    },
  })
})

afterAll(async () => {
  await cleanupFirm(firm.id)
  await disconnectDb()
})

describe('GET /api/opportunities — demo/live separation (Section 4 #2)', () => {
  it('hides demo rows by default; only the live opportunity is returned', async () => {
    const res = await request(app)
      .get('/api/opportunities')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200)

    const titles = res.body.data.map((o: { title: string }) => o.title)
    expect(titles).toContain('Live Opportunity')
    expect(titles).not.toContain('Seeded Demo Opportunity')
    expect(res.body.data.every((o: { isDemo?: boolean }) => o.isDemo !== true)).toBe(true)
  })

  it('includeDemo=true returns demo rows, labeled with isDemo=true', async () => {
    const res = await request(app)
      .get('/api/opportunities?includeDemo=true')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200)

    const demo = res.body.data.find((o: { title: string }) => o.title === 'Seeded Demo Opportunity')
    expect(demo).toBeTruthy()
    expect(demo.isDemo).toBe(true)
  })

  it('live rows are not misclassified as demo', async () => {
    const res = await request(app)
      .get('/api/opportunities?includeDemo=true')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200)

    const live = res.body.data.find((o: { title: string }) => o.title === 'Live Opportunity')
    expect(live.isDemo).toBe(false)
  })
})
