// =============================================================
// Section 4 #5 — backtest runs orphaned in RUNNING must be reaped, and old
// FAILED runs pruned, so stuck/failed jobs cannot accumulate (the proposal saw
// a run stuck RUNNING ~18 days).
//
// Pure-predicate tests need no DB; the sweep tests exercise real prisma.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '../config/database'
import {
  isStaleBacktestRun,
  reapStaleBacktestRuns,
  cleanupOldFailedBacktestRuns,
  STALE_BACKTEST_MS,
  FAILED_BACKTEST_RETENTION_MS,
} from './backtestReaper'
import { createTestFirm, cleanupFirm, disconnectDb, TestFirm } from '../test-utils/testClient'

describe('isStaleBacktestRun', () => {
  const now = Date.UTC(2026, 7, 4, 12, 0, 0)

  it('treats a null/undefined startedAt as stale', () => {
    expect(isStaleBacktestRun(null, now)).toBe(true)
    expect(isStaleBacktestRun(undefined, now)).toBe(true)
  })

  it('is NOT stale within the window, nor exactly at the boundary', () => {
    expect(isStaleBacktestRun(new Date(now - 10 * 60 * 1000), now)).toBe(false)
    expect(isStaleBacktestRun(new Date(now - STALE_BACKTEST_MS), now)).toBe(false)
  })

  it('is stale once older than the window (incl. the 18-day orphan)', () => {
    expect(isStaleBacktestRun(new Date(now - STALE_BACKTEST_MS - 1), now)).toBe(true)
    expect(isStaleBacktestRun(new Date(now - 18 * 24 * 60 * 60 * 1000), now)).toBe(true)
  })

  it('honors a custom staleMs override', () => {
    const tenMinAgo = new Date(now - 10 * 60 * 1000)
    expect(isStaleBacktestRun(tenMinAgo, now, 5 * 60 * 1000)).toBe(true)
    expect(isStaleBacktestRun(tenMinAgo, now, 30 * 60 * 1000)).toBe(false)
  })
})

describe('backtest reaper sweeps (real DB)', () => {
  let firm: TestFirm
  const now = Date.now()

  beforeAll(async () => {
    firm = await createTestFirm({ name: 'Reaper Firm' })
  })
  afterAll(async () => {
    await prisma.backtestRun.deleteMany({ where: { consultingFirmId: firm.id } })
    await cleanupFirm(firm.id)
    await disconnectDb()
  })

  it('reaps a stale RUNNING run but leaves a fresh RUNNING run and COMPLETE runs alone', async () => {
    const stale = await prisma.backtestRun.create({
      data: { consultingFirmId: firm.id, status: 'RUNNING', sampleSize: 50, yearsBack: 3, startedAt: new Date(now - 2 * STALE_BACKTEST_MS) },
    })
    const fresh = await prisma.backtestRun.create({
      data: { consultingFirmId: firm.id, status: 'RUNNING', sampleSize: 50, yearsBack: 3, startedAt: new Date(now - 60 * 1000) },
    })
    const done = await prisma.backtestRun.create({
      data: { consultingFirmId: firm.id, status: 'COMPLETE', sampleSize: 50, yearsBack: 3, startedAt: new Date(now - 5 * STALE_BACKTEST_MS), completedAt: new Date(now - 4 * STALE_BACKTEST_MS) },
    })

    const reaped = await reapStaleBacktestRuns(now)
    expect(reaped).toBeGreaterThanOrEqual(1)

    expect((await prisma.backtestRun.findUnique({ where: { id: stale.id } }))?.status).toBe('FAILED')
    expect((await prisma.backtestRun.findUnique({ where: { id: fresh.id } }))?.status).toBe('RUNNING')
    expect((await prisma.backtestRun.findUnique({ where: { id: done.id } }))?.status).toBe('COMPLETE')
  })

  it('prunes old FAILED runs but keeps recent FAILED and any COMPLETE runs', async () => {
    const oldFailed = await prisma.backtestRun.create({
      data: {
        consultingFirmId: firm.id,
        status: 'FAILED',
        sampleSize: 50,
        yearsBack: 3,
        startedAt: new Date(now - FAILED_BACKTEST_RETENTION_MS - 10 * 86_400_000),
        completedAt: new Date(now - FAILED_BACKTEST_RETENTION_MS - 10 * 86_400_000),
      },
    })
    const recentFailed = await prisma.backtestRun.create({
      data: { consultingFirmId: firm.id, status: 'FAILED', sampleSize: 50, yearsBack: 3, startedAt: new Date(now - 86_400_000), completedAt: new Date(now - 86_400_000) },
    })
    const oldComplete = await prisma.backtestRun.create({
      data: {
        consultingFirmId: firm.id,
        status: 'COMPLETE',
        sampleSize: 50,
        yearsBack: 3,
        startedAt: new Date(now - FAILED_BACKTEST_RETENTION_MS - 20 * 86_400_000),
        completedAt: new Date(now - FAILED_BACKTEST_RETENTION_MS - 20 * 86_400_000),
      },
    })

    const pruned = await cleanupOldFailedBacktestRuns(now)
    expect(pruned).toBeGreaterThanOrEqual(1)

    expect(await prisma.backtestRun.findUnique({ where: { id: oldFailed.id } })).toBeNull()
    expect(await prisma.backtestRun.findUnique({ where: { id: recentFailed.id } })).not.toBeNull()
    expect(await prisma.backtestRun.findUnique({ where: { id: oldComplete.id } })).not.toBeNull()
  })
})
