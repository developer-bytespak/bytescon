// Contact providers fall back. Clay used to be reached only when SAM.gov wasn't
// configured at all, so a prime SAM.gov had no contacts for stayed empty even
// with Clay available.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const update = vi.fn(async () => ({ contactsFetchedAt: new Date() }))
vi.mock('../config/database', () => ({
  prisma: {
    recipientProfile: {
      findUnique: vi.fn(async () => ({ uei: 'ABCDEFGHIJK1', legalName: 'Prime', fetchedAt: new Date(), website: null })),
      update: (...a: unknown[]) => (update as unknown as (...x: unknown[]) => unknown)(...a),
      upsert: vi.fn(async () => ({ uei: 'ABCDEFGHIJK1', legalName: 'Prime', website: null })),
    },
  },
}))
vi.mock('../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('./samEntityApi', () => ({ lookupEntityByUEI: vi.fn(async () => ({ legalBusinessName: 'Prime' })) }))

const sam = { key: 'sam', label: 'SAM', isAvailable: vi.fn(() => true), fetchContacts: vi.fn() }
const clay = { key: 'clay', label: 'Clay', isAvailable: vi.fn(() => true), fetchContacts: vi.fn() }
vi.mock('./contactProviders', () => ({
  getContactProvider: (key: string) => ({ sam, clay } as Record<string, unknown>)[key] ?? null,
  getAvailableProviders: () => [sam, clay].filter((p) => p.isAvailable()),
}))

import { enrichContacts } from './recipientProfileService'

const UEI = 'ABCDEFGHIJK1'
const contact = { name: 'A Person', email: 'a@example.com' }

beforeEach(() => {
  sam.fetchContacts.mockReset()
  clay.fetchContacts.mockReset()
  sam.isAvailable.mockReturnValue(true)
  clay.isAvailable.mockReturnValue(true)
})

describe('enrichContacts', () => {
  it('stops at the first provider with contacts', async () => {
    sam.fetchContacts.mockResolvedValue([contact])
    const r = await enrichContacts(UEI)
    expect(r.provider).toBe('sam')
    expect(clay.fetchContacts).not.toHaveBeenCalled()
  })

  it('tries the next provider when the first finds nobody', async () => {
    sam.fetchContacts.mockResolvedValue([])
    clay.fetchContacts.mockResolvedValue([contact])
    const r = await enrichContacts(UEI)
    expect(r.provider).toBe('clay')
    expect(r.contacts).toEqual([contact])
  })

  it('tries the next provider when the first fails', async () => {
    sam.fetchContacts.mockRejectedValue(new Error('SAM is down'))
    clay.fetchContacts.mockResolvedValue([contact])
    expect((await enrichContacts(UEI)).provider).toBe('clay')
  })

  it('reports the failure when every provider failed, without overwriting saved contacts', async () => {
    update.mockClear()
    sam.fetchContacts.mockRejectedValue(new Error('SAM is down'))
    clay.fetchContacts.mockRejectedValue(new Error('Clay is down'))
    await expect(enrichContacts(UEI)).rejects.toThrow('Clay is down')
    expect(update).not.toHaveBeenCalled()
  })

  it('only uses the provider a person named', async () => {
    sam.fetchContacts.mockResolvedValue([])
    const r = await enrichContacts(UEI, 'sam')
    expect(r.provider).toBe('sam')
    expect(clay.fetchContacts).not.toHaveBeenCalled()
  })
})
