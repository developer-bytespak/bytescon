// The inbox works out likely primes per candidate, which is slow, and the
// dashboard asks on every load. One firm's answer is shared for a few minutes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const findMany = vi.fn()
const findLikelyPrimes = vi.fn()
vi.mock('../../config/database', () => ({ prisma: { opportunity: { findMany: (...a: unknown[]) => findMany(...a) } } }))
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('./likelyPrimes', () => ({ findLikelyPrimes: (...a: unknown[]) => findLikelyPrimes(...a) }))

import { clearNotificationInboxCache, getNotificationInbox } from './notifications'

const candidate = {
  id: 'o1', title: 'Opp', agency: 'DoD', setAsideType: null, responseDeadline: new Date(Date.now() + 30 * 86_400_000),
  probabilityScore: 0.4, bidDecisions: [],
}

beforeEach(() => {
  clearNotificationInboxCache()
  findMany.mockReset().mockResolvedValue([candidate])
  findLikelyPrimes.mockReset().mockResolvedValue([{ primeName: 'Prime', confidence: { composite: 0.8 } }])
})
afterEach(() => vi.useRealTimers())

describe('getNotificationInbox', () => {
  it('computes once for repeated loads', async () => {
    const [a, b] = await Promise.all([getNotificationInbox({ consultingFirmId: 'f1' }), getNotificationInbox({ consultingFirmId: 'f1' })])
    await getNotificationInbox({ consultingFirmId: 'f1' })
    expect(a).toEqual(b)
    expect(a).toHaveLength(1)
    expect(findLikelyPrimes).toHaveBeenCalledTimes(1)
  })

  it('never shares an answer between firms', async () => {
    await getNotificationInbox({ consultingFirmId: 'f1' })
    await getNotificationInbox({ consultingFirmId: 'f2' })
    expect(findLikelyPrimes).toHaveBeenCalledTimes(2)
    expect(findMany.mock.calls[1][0].where.consultingFirmId).toBe('f2')
  })

  it('works it out again after a few minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await getNotificationInbox({ consultingFirmId: 'f1' })
    vi.setSystemTime(Date.now() + 6 * 60 * 1000)
    await getNotificationInbox({ consultingFirmId: 'f1' })
    expect(findLikelyPrimes).toHaveBeenCalledTimes(2)
  })

  it('does not keep a failure', async () => {
    findMany.mockRejectedValueOnce(new Error('db down'))
    await expect(getNotificationInbox({ consultingFirmId: 'f1' })).rejects.toThrow('db down')
    await expect(getNotificationInbox({ consultingFirmId: 'f1' })).resolves.toHaveLength(1)
  })
})
