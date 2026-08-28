// =============================================================
// §5.2 In-app notifications — list, unread count, mark-read, read-all, and
// per-user isolation (a user never sees or mutates another user's feed).
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

let app: Express
let firm: TestFirm
let a: TestUser
let b: TestUser

const H = (t: string) => ({ Authorization: `Bearer ${t}` })

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Notif Firm' })
  a = await createTestUser(firm.id, { role: 'ADMIN' })
  b = await createTestUser(firm.id, { role: 'ADMIN' })
  await prisma.userNotification.createMany({ data: [
    { consultingFirmId: firm.id, userId: a.id, type: 'QUALIFICATION_DECISION', title: 'A-1', dedupeKey: `k-${a.id}-1` },
    { consultingFirmId: firm.id, userId: a.id, type: 'QUALIFICATION_DECISION', title: 'A-2', dedupeKey: `k-${a.id}-2` },
    { consultingFirmId: firm.id, userId: b.id, type: 'QUALIFICATION_DECISION', title: 'B-1', dedupeKey: `k-${b.id}-1` },
  ] })
})
afterAll(async () => { await cleanupFirm(firm.id); await disconnectDb() })

describe('notifications feed', () => {
  it('lists only the caller notifications with an unread count', async () => {
    const res = await request(app).get('/api/notifications').set(H(a.token)).expect(200)
    expect(res.body.data.items.every((n: { title: string }) => n.title.startsWith('A-'))).toBe(true)
    expect(res.body.data.unreadCount).toBe(2)
  })
  it('marks one read and then all read', async () => {
    const list = await request(app).get('/api/notifications').set(H(a.token)).expect(200)
    const first = list.body.data.items[0]
    await request(app).post(`/api/notifications/${first.id}/read`).set(H(a.token)).expect(200)
    const after = await request(app).get('/api/notifications?unread=true').set(H(a.token)).expect(200)
    expect(after.body.data.unreadCount).toBe(1)
    await request(app).post('/api/notifications/read-all').set(H(a.token)).expect(200)
    const cleared = await request(app).get('/api/notifications').set(H(a.token)).expect(200)
    expect(cleared.body.data.unreadCount).toBe(0)
  })
  it('cannot mark another user notification read (404)', async () => {
    const bList = await request(app).get('/api/notifications').set(H(b.token)).expect(200)
    const bNotif = bList.body.data.items[0]
    await request(app).post(`/api/notifications/${bNotif.id}/read`).set(H(a.token)).expect(404)
  })
})
