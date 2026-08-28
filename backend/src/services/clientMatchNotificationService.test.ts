// =============================================================
// GB-103 — match-diff service integration tests.
// Uses the live test DB (same pattern as route tests) with the mailer
// mocked so no email is actually sent and delivery is deterministic.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'

// Mock the mailer BEFORE importing the service under test.
vi.mock('./mailer', () => ({
  sendEmail: vi.fn(async () => ({ delivered: true, provider: 'resend', providerMessageId: 'test-msg' })),
}))

import { prisma } from '../config/database'
import { sendEmail } from './mailer'
import { runClientMatchNotifications } from './clientMatchNotificationService'
import {
  createTestFirm,
  createTestClient,
  createTestOpportunity,
  cleanupFirm,
  disconnectDb,
  TestFirm,
} from '../test-utils/factories'

const mockedSend = vi.mocked(sendEmail)

let firm: TestFirm
const origFlag = process.env.CLIENT_NOTIFICATIONS_ENABLED

beforeAll(() => {
  process.env.CLIENT_NOTIFICATIONS_ENABLED = '1'
})

afterAll(async () => {
  if (origFlag !== undefined) process.env.CLIENT_NOTIFICATIONS_ENABLED = origFlag
  else delete process.env.CLIENT_NOTIFICATIONS_ENABLED
  await disconnectDb()
})

beforeEach(async () => {
  mockedSend.mockClear()
  firm = await createTestFirm({ name: 'GB-103 Test Firm' })
})

afterEach(async () => {
  await cleanupFirm(firm?.id).catch(() => {})
})

async function setPreference(
  consultingFirmId: string,
  clientCompanyId: string,
  opts: { enabled?: boolean; minMatchThreshold?: number; frequency?: 'IMMEDIATE' | 'DIGEST' } = {},
) {
  await prisma.notificationPreference.create({
    data: {
      consultingFirmId,
      clientCompanyId,
      enabled: opts.enabled ?? true,
      minMatchThreshold: opts.minMatchThreshold ?? 1,
      frequency: opts.frequency ?? 'IMMEDIATE',
    },
  })
}

describe('runClientMatchNotifications', () => {
  it('sends exactly one notification and writes one ledger row for a high-match opportunity', async () => {
    const client = await createTestClient(firm.id, { naicsCodes: ['541330'] })
    const opp = await createTestOpportunity(firm.id, { naicsCode: '541330', title: 'Engineering Support' })
    await setPreference(firm.id, client.id, { minMatchThreshold: 1, frequency: 'IMMEDIATE' })

    const res = await runClientMatchNotifications({ consultingFirmId: firm.id })

    expect(res.enabled).toBe(true)
    expect(mockedSend).toHaveBeenCalledTimes(1)
    expect(res.notificationsSent).toBe(1)

    const ledger = await prisma.sentNotification.findMany({ where: { clientCompanyId: client.id } })
    expect(ledger).toHaveLength(1)
    expect(ledger[0].opportunityId).toBe(opp.id)
    expect(ledger[0].scoreAtSend).toBeGreaterThan(0)

    // High-water mark advanced.
    const after = await prisma.consultingFirm.findUnique({ where: { id: firm.id } })
    expect(after?.lastMatchNotifiedAt).not.toBeNull()
  })

  it('is idempotent — re-running produces zero duplicate sends', async () => {
    const client = await createTestClient(firm.id, { naicsCodes: ['541330'] })
    await createTestOpportunity(firm.id, { naicsCode: '541330' })
    await setPreference(firm.id, client.id, { minMatchThreshold: 1 })

    await runClientMatchNotifications({ consultingFirmId: firm.id })
    mockedSend.mockClear()
    await runClientMatchNotifications({ consultingFirmId: firm.id })

    expect(mockedSend).not.toHaveBeenCalled()
    const ledger = await prisma.sentNotification.count({ where: { clientCompanyId: client.id } })
    expect(ledger).toBe(1)
  })

  it('does not send when a pre-existing ledger row already covers the pair', async () => {
    const client = await createTestClient(firm.id, { naicsCodes: ['541330'] })
    const opp = await createTestOpportunity(firm.id, { naicsCode: '541330' })
    await setPreference(firm.id, client.id, { minMatchThreshold: 1 })
    await prisma.sentNotification.create({
      data: { consultingFirmId: firm.id, clientCompanyId: client.id, opportunityId: opp.id, scoreAtSend: 50 },
    })

    await runClientMatchNotifications({ consultingFirmId: firm.id })

    expect(mockedSend).not.toHaveBeenCalled()
    const ledger = await prisma.sentNotification.count({ where: { clientCompanyId: client.id } })
    expect(ledger).toBe(1)
  })

  it('excludes clients below their match threshold', async () => {
    const client = await createTestClient(firm.id, { naicsCodes: ['541330'] })
    await createTestOpportunity(firm.id, { naicsCode: '541330' })
    await setPreference(firm.id, client.id, { minMatchThreshold: 99 })

    await runClientMatchNotifications({ consultingFirmId: firm.id })

    expect(mockedSend).not.toHaveBeenCalled()
    expect(await prisma.sentNotification.count({ where: { clientCompanyId: client.id } })).toBe(0)
  })

  it('excludes clients with notifications disabled', async () => {
    const client = await createTestClient(firm.id, { naicsCodes: ['541330'] })
    await createTestOpportunity(firm.id, { naicsCode: '541330' })
    await setPreference(firm.id, client.id, { enabled: false, minMatchThreshold: 1 })

    await runClientMatchNotifications({ consultingFirmId: firm.id })

    expect(mockedSend).not.toHaveBeenCalled()
    expect(await prisma.sentNotification.count({ where: { clientCompanyId: client.id } })).toBe(0)
  })

  it('aggregates multiple matches into a single digest email', async () => {
    const client = await createTestClient(firm.id, { naicsCodes: ['541330'] })
    await createTestOpportunity(firm.id, { naicsCode: '541330', title: 'Opp A' })
    await createTestOpportunity(firm.id, { naicsCode: '541330', title: 'Opp B' })
    await setPreference(firm.id, client.id, { minMatchThreshold: 1, frequency: 'DIGEST' })

    await runClientMatchNotifications({ consultingFirmId: firm.id })

    expect(mockedSend).toHaveBeenCalledTimes(1)
    const ledger = await prisma.sentNotification.count({ where: { clientCompanyId: client.id } })
    expect(ledger).toBe(2)
  })

  it('never notifies on award notices, even at a perfect match', async () => {
    const client = await createTestClient(firm.id, { naicsCodes: ['541330'] })
    await createTestOpportunity(firm.id, {
      naicsCode: '541330',
      title: 'Already Awarded Engineering IDIQ',
      noticeType: 'Award Notice',
    })
    await setPreference(firm.id, client.id, { minMatchThreshold: 1, frequency: 'IMMEDIATE' })

    const res = await runClientMatchNotifications({ consultingFirmId: firm.id })

    expect(res.notificationsSent).toBe(0)
    expect(mockedSend).not.toHaveBeenCalled()
    expect(await prisma.sentNotification.count({ where: { clientCompanyId: client.id } })).toBe(0)
  })

  it('does nothing when the feature flag is off', async () => {
    const client = await createTestClient(firm.id, { naicsCodes: ['541330'] })
    await createTestOpportunity(firm.id, { naicsCode: '541330' })
    await setPreference(firm.id, client.id, { minMatchThreshold: 1 })

    process.env.CLIENT_NOTIFICATIONS_ENABLED = ''
    try {
      const res = await runClientMatchNotifications({ consultingFirmId: firm.id })
      expect(res.enabled).toBe(false)
    } finally {
      process.env.CLIENT_NOTIFICATIONS_ENABLED = '1'
    }
    expect(mockedSend).not.toHaveBeenCalled()
    expect(await prisma.sentNotification.count({ where: { clientCompanyId: client.id } })).toBe(0)
  })
})
