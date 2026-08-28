// =============================================================
// §7.0 — Agent notification fan-out against the real UserNotification store.
//
// The properties that matter: nothing is written twice on a retry, a user's
// per-agent preference is genuinely honoured, and a notification failure never
// changes a run's outcome.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { prisma } from '../../config/database'
import {
  createTestFirm, createTestUser, cleanupFirm, disconnectDb, type TestFirm, type TestUser,
} from '../../test-utils/testClient'
import { notifyAgentOutcome, resolvePreference, DEFAULT_AGENT_NOTIFICATION_PREFERENCE } from './notifications'

let firmA: TestFirm
let firmB: TestFirm
let adminA: TestUser
let consultantA: TestUser
let adminB: TestUser

const AGENT = 'PRICING' as const

beforeAll(async () => {
  firmA = await createTestFirm({ name: 'Agent Notify Firm A' })
  firmB = await createTestFirm({ name: 'Agent Notify Firm B' })
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
    await prisma.userNotification.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentNotificationPreference.deleteMany({ where: { consultingFirmId: id } })
  }
})

const args = (over: Record<string, unknown> = {}) => ({
  consultingFirmId: firmA.id,
  agentKey: AGENT,
  runId: 'run-fixed-1',
  kind: 'FAILURE' as const,
  title: 'Agent run failed',
  body: 'Something went wrong.',
  ...over,
})

describe('agent notification fan-out', () => {
  it('notifies firm admins on failure by default', async () => {
    const res = await notifyAgentOutcome(args())
    expect(res.notified).toBe(1)

    const rows = await prisma.userNotification.findMany({ where: { consultingFirmId: firmA.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].userId).toBe(adminA.id)
    expect(rows[0].type).toBe('AGENT_RUN_FAILED')
    expect(rows[0].linkPath).toBe('/agents/runs/run-fixed-1')
  })

  it('does NOT notify routine successes by default', async () => {
    const res = await notifyAgentOutcome(args({ kind: 'SUCCESS', title: 'done' }))
    expect(res.notified).toBe(0)
    expect(res.suppressed).toBe(1)
    expect(await prisma.userNotification.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it('notifies successes once the user opts in', async () => {
    await prisma.agentNotificationPreference.create({
      data: { consultingFirmId: firmA.id, userId: adminA.id, agentKey: AGENT, notifyOnSuccess: true },
    })
    const res = await notifyAgentOutcome(args({ kind: 'SUCCESS', title: 'done' }))
    expect(res.notified).toBe(1)
  })

  it('is idempotent — a retry of the same run does not notify twice', async () => {
    await notifyAgentOutcome(args())
    await notifyAgentOutcome(args())
    expect(await prisma.userNotification.count({ where: { consultingFirmId: firmA.id } })).toBe(1)
  })

  it('suppresses everything when the user turns in-app notifications off', async () => {
    await prisma.agentNotificationPreference.create({
      data: { consultingFirmId: firmA.id, userId: adminA.id, agentKey: AGENT, inAppEnabled: false },
    })
    const res = await notifyAgentOutcome(args())
    expect(res.notified).toBe(0)
    expect(res.suppressed).toBe(1)
  })

  it('honours the minimum severity for escalations', async () => {
    await prisma.agentNotificationPreference.create({
      data: { consultingFirmId: firmA.id, userId: adminA.id, agentKey: AGENT, minimumSeverity: 'CRITICAL' },
    })

    const low = await notifyAgentOutcome(args({ kind: 'ESCALATION', severity: 'LOW', escalationId: 'esc-1', title: 'low' }))
    expect(low.notified).toBe(0)

    const critical = await notifyAgentOutcome(args({ kind: 'ESCALATION', severity: 'CRITICAL', escalationId: 'esc-2', title: 'critical' }))
    expect(critical.notified).toBe(1)
    const row = await prisma.userNotification.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })
    expect(row.type).toBe('AGENT_ESCALATION')
    expect(row.linkPath).toContain('/agents/escalations')
  })

  it('applies a preference per agent, not globally', async () => {
    await prisma.agentNotificationPreference.create({
      data: { consultingFirmId: firmA.id, userId: adminA.id, agentKey: AGENT, notifyOnFailure: false },
    })
    const silenced = await notifyAgentOutcome(args())
    expect(silenced.notified).toBe(0)

    const otherAgent = await notifyAgentOutcome(args({ agentKey: 'FINANCE', runId: 'run-fixed-2' }))
    expect(otherAgent.notified).toBe(1)
  })

  it('includes an explicitly assigned user even when they are not an admin', async () => {
    const res = await notifyAgentOutcome(args({ assignedToUserId: consultantA.id }))
    expect(res.notified).toBe(2)
    const userIds = (await prisma.userNotification.findMany({ where: { consultingFirmId: firmA.id } })).map((n) => n.userId)
    expect(userIds).toEqual(expect.arrayContaining([adminA.id, consultantA.id]))
  })

  it('never notifies another firm’s users', async () => {
    await notifyAgentOutcome(args())
    expect(await prisma.userNotification.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
    expect(await prisma.userNotification.count({ where: { userId: adminB.id } })).toBe(0)
  })

  it('returns the documented defaults when no preference row exists', async () => {
    const pref = await resolvePreference(adminA.id, AGENT)
    expect(pref).toEqual(DEFAULT_AGENT_NOTIFICATION_PREFERENCE)
  })

  it('never throws — a notification failure cannot change a run outcome', async () => {
    // A non-existent tenant makes recipient resolution return nothing.
    await expect(
      notifyAgentOutcome({ ...args(), consultingFirmId: 'firm-that-does-not-exist' }),
    ).resolves.toEqual({ notified: 0, suppressed: 0 })
  })
})
