// =============================================================
// jobHealth — heartbeat ledger + dead-man's-switch staleness sweep
// (integration, live test DB; alert channel mocked). Guards the
// watchdog semantics: fresh jobs stay quiet, stale jobs page, jobs
// that never ran get one full window of grace from first sighting.
// =============================================================
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

vi.mock('./alertService', () => ({
  sendOpsAlert: vi.fn(async () => ({ sent: true, channels: ['email'] })),
}))

import { prisma } from '../config/database'
import { sendOpsAlert } from './alertService'
import {
  recordJobSuccess,
  recordJobFailure,
  checkJobHeartbeats,
  ExpectedJob,
} from './jobHealth'

const mockedAlert = vi.mocked(sendOpsAlert)

let seq = 0
const uniq = (prefix: string) => `${prefix}-${Date.now()}-${process.pid}-${++seq}`
const createdJobs: string[] = []
const job = (prefix: string) => {
  const name = uniq(prefix)
  createdJobs.push(name)
  return name
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000)

beforeEach(() => {
  vi.clearAllMocks()
})

afterAll(async () => {
  await prisma.jobHeartbeat.deleteMany({ where: { jobName: { in: createdJobs } } })
  await prisma.$disconnect()
})

describe('heartbeat ledger', () => {
  it('recordJobSuccess upserts and clears the last error', async () => {
    const name = job('hb-success')
    await recordJobFailure(name, 'it broke')
    await recordJobSuccess(name)
    const row = await prisma.jobHeartbeat.findUnique({ where: { jobName: name } })
    expect(row?.lastSuccessAt).toBeTruthy()
    expect(row?.lastError).toBeNull()
    expect(row?.lastFailureAt).toBeTruthy() // failure history is kept
  })
})

describe('checkJobHeartbeats', () => {
  it('is quiet for a job that succeeded inside its window', async () => {
    const name = job('hb-fresh')
    await recordJobSuccess(name)
    const registry: ExpectedJob[] = [{ jobName: name, expectEveryHours: 26 }]
    const stale = await checkJobHeartbeats(registry)
    expect(stale).toHaveLength(0)
    expect(mockedAlert).not.toHaveBeenCalled()
  })

  it('pages for a job whose last success is outside its window', async () => {
    const name = job('hb-stale')
    await prisma.jobHeartbeat.create({
      data: { jobName: name, lastSuccessAt: hoursAgo(30), lastError: 'SAM timeout' },
    })
    const stale = await checkJobHeartbeats([{ jobName: name, expectEveryHours: 26 }])
    expect(stale).toHaveLength(1)
    expect(stale[0]).toMatchObject({ jobName: name, lastError: 'SAM timeout' })
    expect(mockedAlert).toHaveBeenCalledTimes(1)
    expect(mockedAlert.mock.calls[0][0]).toMatchObject({ key: `job-stale:${name}`, severity: 'critical' })
  })

  it('gives an unseen job one full window of grace, then pages as NEVER succeeded', async () => {
    const name = job('hb-never')
    // first sweep: creates the placeholder, no alert
    let stale = await checkJobHeartbeats([{ jobName: name, expectEveryHours: 26 }])
    expect(stale).toHaveLength(0)
    expect(mockedAlert).not.toHaveBeenCalled()

    // still inside the window from first sighting: quiet
    stale = await checkJobHeartbeats([{ jobName: name, expectEveryHours: 26 }])
    expect(stale).toHaveLength(0)

    // age the placeholder past the window → NEVER-succeeded page
    await prisma.jobHeartbeat.update({ where: { jobName: name }, data: { createdAt: hoursAgo(30) } })
    stale = await checkJobHeartbeats([{ jobName: name, expectEveryHours: 26 }])
    expect(stale).toHaveLength(1)
    expect(stale[0].hoursSinceSuccess).toBeNull()
    expect(mockedAlert.mock.calls[0][0].title).toContain('NEVER succeeded')
  })

  it('skips jobs whose feature flag is off', async () => {
    const name = job('hb-gated')
    await prisma.jobHeartbeat.create({ data: { jobName: name, lastSuccessAt: hoursAgo(999) } })
    const stale = await checkJobHeartbeats([
      { jobName: name, expectEveryHours: 26, enabled: () => false },
    ])
    expect(stale).toHaveLength(0)
    expect(mockedAlert).not.toHaveBeenCalled()
  })

  it('a recovered job goes quiet again', async () => {
    const name = job('hb-recovered')
    await prisma.jobHeartbeat.create({ data: { jobName: name, lastSuccessAt: hoursAgo(30) } })
    await recordJobSuccess(name)
    const stale = await checkJobHeartbeats([{ jobName: name, expectEveryHours: 26 }])
    expect(stale).toHaveLength(0)
  })
})
