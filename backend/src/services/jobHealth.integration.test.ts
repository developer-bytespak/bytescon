// =============================================================
// Job health (B13, B23) — failure alerts and the dead-man's switch.
//
// B13: the Section 6 worker (source sync, saved-search alerts, milestone
// reminders, discovery intel) and GB-107 had no failure alerts and no
// staleness watch. Each of their jobs now has its own heartbeat.
// B23: the "nightly backup silent" alert fired every day for a host script
// that no longer exists; it is only watched when such a script is set up.
// =============================================================
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { Job, Worker } from 'bullmq'

const sendOpsAlertSpy = vi.fn(async () => ({ sent: true, channels: ['test'] }))
vi.mock('./alertService', () => ({ sendOpsAlert: (...a: unknown[]) => sendOpsAlertSpy(...(a as [])) }))

import { prisma } from '../config/database'
import { wireJobObservability, checkJobHeartbeats, EXPECTED_JOBS, type ExpectedJob } from './jobHealth'

const RUN = `jh-${Date.now()}`
const name = (n: string) => `${RUN}-${n}`
const fakeWorker = () => new EventEmitter()
const asWorker = (e: EventEmitter) => e as unknown as Worker
const job = (jobName: string, data: Record<string, unknown> = {}) => ({ name: jobName, data }) as unknown as Job

/** Event handlers write heartbeats without awaiting; let them land. */
const settle = async (jobName: string, field: 'lastSuccessAt' | 'lastFailureAt') => {
  for (let i = 0; i < 50; i++) {
    const row = await prisma.jobHeartbeat.findUnique({ where: { jobName } })
    if (row?.[field]) return row
    await new Promise((r) => setTimeout(r, 20))
  }
  return prisma.jobHeartbeat.findUnique({ where: { jobName } })
}

beforeEach(() => {
  sendOpsAlertSpy.mockClear()
})

afterAll(async () => {
  await prisma.jobHeartbeat.deleteMany({ where: { jobName: { startsWith: RUN } } })
  await prisma.$disconnect()
})

describe('a worker that runs several scheduled jobs', () => {
  it('records a separate heartbeat for each job', async () => {
    const worker = fakeWorker()
    wireJobObservability(asWorker(worker), name('multi'), { nameOf: (j) => name(j.name) })

    worker.emit('completed', job('source-sync'))
    worker.emit('completed', job('profile-alerts'))

    expect((await settle(name('source-sync'), 'lastSuccessAt'))?.lastSuccessAt).toBeInstanceOf(Date)
    expect((await settle(name('profile-alerts'), 'lastSuccessAt'))?.lastSuccessAt).toBeInstanceOf(Date)
    // Nothing is filed under the worker-level name.
    expect(await prisma.jobHeartbeat.findUnique({ where: { jobName: name('multi') } })).toBeNull()
  })

  it("alerts ops when one job fails, naming that job", async () => {
    const worker = fakeWorker()
    wireJobObservability(asWorker(worker), name('multi'), { nameOf: (j) => name(j.name) })

    worker.emit('failed', job('milestone-reminders'), new Error('reminder query timed out'))

    const row = await settle(name('milestone-reminders'), 'lastFailureAt')
    expect(row?.lastError).toBe('reminder query timed out')
    expect(sendOpsAlertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        key: `job-failed:${name('milestone-reminders')}`,
        severity: 'critical',
        title: `Background job failed: ${name('milestone-reminders')}`,
      }),
    )
  })

  it('uses the given severity (GB-107 is a warning)', async () => {
    const worker = fakeWorker()
    wireJobObservability(asWorker(worker), name('gb107'), {
      severity: 'warning',
      nameOf: (j) => (j.data?.kind === 'poll-queued' ? name('gb107-poll') : name('gb107-backfill')),
    })
    worker.emit('failed', job('batch-backfill', { kind: 'batch-backfill' }), new Error('SAM 500'))
    await settle(name('gb107-backfill'), 'lastFailureAt')
    expect(sendOpsAlertSpy).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warning', key: `job-failed:${name('gb107-backfill')}` }))
  })

  it('keeps one heartbeat per worker when no per-job name is given', async () => {
    const worker = fakeWorker()
    wireJobObservability(asWorker(worker), name('single'))
    worker.emit('completed', job('anything'))
    expect((await settle(name('single'), 'lastSuccessAt'))?.lastSuccessAt).toBeInstanceOf(Date)
  })
})

describe('the dead-man’s switch', () => {
  it('alerts when a watched job has gone silent past its window', async () => {
    const registry: ExpectedJob[] = [{ jobName: name('stale'), expectEveryHours: 2 }]
    await prisma.jobHeartbeat.create({ data: { jobName: name('stale'), lastSuccessAt: new Date(Date.now() - 3 * 3_600_000) } })

    const stale = await checkJobHeartbeats(registry)
    expect(stale.map((s) => s.jobName)).toEqual([name('stale')])
    expect(sendOpsAlertSpy).toHaveBeenCalledWith(expect.objectContaining({ key: `job-stale:${name('stale')}` }))
  })

  it('stays quiet for a job inside its window', async () => {
    const registry: ExpectedJob[] = [{ jobName: name('fresh'), expectEveryHours: 2 }]
    await prisma.jobHeartbeat.create({ data: { jobName: name('fresh'), lastSuccessAt: new Date() } })
    expect(await checkJobHeartbeats(registry)).toEqual([])
    expect(sendOpsAlertSpy).not.toHaveBeenCalled()
  })

  it('watches every Section 6 and GB-107 job', () => {
    const watched = new Map(EXPECTED_JOBS.map((j) => [j.jobName, j]))
    for (const jobName of ['source-sync', 'profile-alerts', 'milestone-reminders', 'discovery-intel', 'gb107-poll', 'gb107-backfill']) {
      const entry = watched.get(jobName)
      expect(entry, jobName).toBeDefined()
      expect(entry!.enabled?.() ?? true, jobName).toBe(true)
    }
  })
})

describe('the nightly-backup watch (B23)', () => {
  const ORIGINAL = process.env.NIGHTLY_BACKUP_HEARTBEAT_ENABLED
  const backup = EXPECTED_JOBS.find((j) => j.jobName === 'nightly-backup')!

  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.NIGHTLY_BACKUP_HEARTBEAT_ENABLED
    else process.env.NIGHTLY_BACKUP_HEARTBEAT_ENABLED = ORIGINAL
  })

  it('is off unless a backup script is set up', async () => {
    delete process.env.NIGHTLY_BACKUP_HEARTBEAT_ENABLED
    expect(backup.enabled?.()).toBe(false)

    // Even a long-silent backup row raises nothing while it is off.
    const registry: ExpectedJob[] = [{ ...backup, jobName: name('nightly-backup') }]
    await prisma.jobHeartbeat.create({ data: { jobName: name('nightly-backup'), lastSuccessAt: new Date(Date.now() - 40 * 86_400_000) } })
    expect(await checkJobHeartbeats(registry)).toEqual([])
    expect(sendOpsAlertSpy).not.toHaveBeenCalled()
  })

  it('is watched once NIGHTLY_BACKUP_HEARTBEAT_ENABLED=true', () => {
    process.env.NIGHTLY_BACKUP_HEARTBEAT_ENABLED = 'true'
    expect(backup.enabled?.()).toBe(true)
  })
})
