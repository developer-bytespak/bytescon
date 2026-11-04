// B21 — the partner grant picker lists every contract, not just the first 100.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const get = vi.hoisted(() => vi.fn())
vi.mock('./api', async (original) => ({ ...(await original<object>()), default: { get, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }, api: { get, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } }))

import { loadContractOptions } from './crmApi'

const page = (from: number, count: number, totalPages: number) => ({
  data: {
    data: Array.from({ length: count }, (_, i) => ({ id: `c${from + i}`, contractNumber: `N${from + i}`, title: 'T' })),
    meta: { totalPages },
  },
})

beforeEach(() => get.mockReset())

describe('loadContractOptions', () => {
  it('reads every page', async () => {
    get.mockResolvedValueOnce(page(0, 100, 3)).mockResolvedValueOnce(page(100, 100, 3)).mockResolvedValueOnce(page(200, 7, 3))
    const options = await loadContractOptions()
    expect(options).toHaveLength(207)
    expect(get).toHaveBeenCalledTimes(3)
    expect(get).toHaveBeenLastCalledWith('/contract-management', { params: { limit: 100, page: 3 } })
  })

  it('stops after one page when that is all there is', async () => {
    get.mockResolvedValueOnce(page(0, 5, 1))
    expect(await loadContractOptions()).toHaveLength(5)
    expect(get).toHaveBeenCalledTimes(1)
  })
})
