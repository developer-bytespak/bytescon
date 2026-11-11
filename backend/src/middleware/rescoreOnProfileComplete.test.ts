import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

const statuses = vi.fn()
const enqueue = vi.fn()
vi.mock('../services/profileGate', () => ({ clientProfileStatuses: (id: string) => statuses(id) }))
vi.mock('../workers/scoringWorker', () => ({ enqueueAllOpportunitiesForScoring: (id: string) => enqueue(id) }))

import { rescoreOnProfileComplete, rescoreIfNewlyComplete } from './rescoreOnProfileComplete'

const status = (...complete: string[]) => ({ clients: ['a', 'b'].map((id) => ({ clientCompanyId: id, complete: complete.includes(id) })) })

function run(method: string, statusCode: number) {
  const res = Object.assign(new EventEmitter(), { statusCode })
  const req = { method, user: { consultingFirmId: 'firm-1' } }
  return new Promise<void>((resolve) => {
    rescoreOnProfileComplete(req as never, res as never, () => {
      res.emit('finish')
      setTimeout(resolve, 0)
    })
  })
}

beforeEach(() => {
  statuses.mockReset(); enqueue.mockReset()
  enqueue.mockResolvedValue(2)
})

describe('rescoreOnProfileComplete', () => {
  it('queues scoring when a save completes a profile', async () => {
    statuses.mockResolvedValueOnce(status()).mockResolvedValueOnce(status('a'))
    await run('PUT', 200)
    expect(enqueue).toHaveBeenCalledWith('firm-1')
  })

  it('does nothing when no profile changed to complete', async () => {
    statuses.mockResolvedValue(status('a'))
    await run('PUT', 200)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('does nothing when the save failed', async () => {
    statuses.mockResolvedValueOnce(status()).mockResolvedValueOnce(status('a'))
    await run('PUT', 422)
    expect(statuses).toHaveBeenCalledTimes(1)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('lets reads straight through', async () => {
    await run('GET', 200)
    expect(statuses).not.toHaveBeenCalled()
  })

  it('never blocks the save when the check fails', async () => {
    statuses.mockRejectedValue(new Error('db down'))
    await run('POST', 200)
    expect(enqueue).not.toHaveBeenCalled()
  })
})

describe('rescoreIfNewlyComplete', () => {
  it('returns how many opportunities were queued', async () => {
    statuses.mockResolvedValue(status('a', 'b'))
    expect(await rescoreIfNewlyComplete('firm-1', new Set(['a']))).toBe(2)
    expect(await rescoreIfNewlyComplete('firm-1', new Set(['a', 'b']))).toBe(0)
  })
})
