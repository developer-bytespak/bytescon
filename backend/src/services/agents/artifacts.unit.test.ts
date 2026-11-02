// =============================================================
// carryForwardSections — pure-logic units with the database mocked.
//
// An event run that skips phases must keep the full sweep's sections instead
// of superseding them with empty defaults, and must report exactly which
// sections it carried.
// =============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest'

const findFirst = vi.fn()
vi.mock('../../config/database', () => ({ prisma: { agentArtifact: { findFirst: (...a: unknown[]) => findFirst(...a) } } }))

import { carryForwardSections } from './artifacts'

const base = {
  consultingFirmId: 'firm-1',
  agentKey: 'FINANCE' as const,
  artifactType: 'FINANCE_STATUS' as const,
  sourceEntityType: 'ConsultingFirm',
  sourceEntityId: 'firm-1',
}

beforeEach(() => findFirst.mockReset())

describe('carryForwardSections', () => {
  it('copies only the requested sections from the current artifact', async () => {
    findFirst.mockResolvedValue({ structuredData: { timekeeping: { score: 80 }, invoices: { drafts: 2 }, cashFlow: { net: 5 } } })
    const status = { timekeeping: { score: 0 }, invoices: { drafts: 0 }, cashFlow: { net: 9 } }

    const carried = await carryForwardSections({ ...base, status, keys: ['timekeeping', 'invoices'] })

    expect(carried).toEqual(['timekeeping', 'invoices'])
    expect(status).toEqual({ timekeeping: { score: 80 }, invoices: { drafts: 2 }, cashFlow: { net: 9 } })
  })

  it('reads only the non-superseded artifact for the same subject', async () => {
    findFirst.mockResolvedValue(null)
    await carryForwardSections({ ...base, status: { a: 1 }, keys: ['a'] })

    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        consultingFirmId: 'firm-1',
        agentKey: 'FINANCE',
        artifactType: 'FINANCE_STATUS',
        sourceEntityType: 'ConsultingFirm',
        sourceEntityId: 'firm-1',
        supersededByArtifactId: null,
      },
      orderBy: { createdAt: 'desc' },
    }))
  })

  it('carries nothing and leaves the status untouched when there is no prior artifact', async () => {
    findFirst.mockResolvedValue(null)
    const status = { timekeeping: { score: 0 } }

    expect(await carryForwardSections({ ...base, status, keys: ['timekeeping'] })).toEqual([])
    expect(status).toEqual({ timekeeping: { score: 0 } })
  })

  it('skips a section the prior artifact does not have', async () => {
    findFirst.mockResolvedValue({ structuredData: { invoices: { drafts: 1 } } })
    const status = { timekeeping: { score: 0 }, invoices: { drafts: 0 } }

    expect(await carryForwardSections({ ...base, status, keys: ['timekeeping', 'invoices'] })).toEqual(['invoices'])
    expect(status.timekeeping).toEqual({ score: 0 })
  })

  it('does not query the database when no section was skipped', async () => {
    expect(await carryForwardSections({ ...base, status: { a: 1 }, keys: [] })).toEqual([])
    expect(findFirst).not.toHaveBeenCalled()
  })
})
