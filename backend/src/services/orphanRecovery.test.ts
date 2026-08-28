// =============================================================
// Orphaned document-job recovery — unit tests (P1-5)
//
// Verifies the startup reaper transitions documents stuck in a running state
// (IN_PROGRESS / EXTRACTING) past the threshold to a terminal FAILED state,
// targets ONLY the running states (never terminal ones), respects a custom
// threshold/clock, and recovers a document orphaned in BOTH states in one
// run. The Prisma client is injected as a stateful mock whose updateMany
// simulates the @updatedAt bump Prisma applies to every row it touches.
// =============================================================
import { describe, it, expect } from 'vitest'
import { recoverOrphanedDocuments, ORPHAN_THRESHOLD_MS } from './orphanRecovery'

// Fixed clock so the cutoff date is deterministic.
const NOW = 1_700_000_000_000

// One minute past the default threshold: always orphan-eligible.
const STALE = new Date(NOW - ORPHAN_THRESHOLD_MS - 60_000)
// One minute inside the default threshold: never orphan-eligible.
const FRESH = new Date(NOW - ORPHAN_THRESHOLD_MS + 60_000)

interface DocRow {
  id: string
  analysisStatus: string
  extractionStatus: string
  updatedAt: Date
  analysisError?: string | null
  extractionError?: string | null
}

// Minimal Prisma-style where matcher covering the shapes the reaper uses:
// status equality, `updatedAt: { lt }`, and `id: { in }`.
function matches(d: DocRow, where: any): boolean {
  if (where.id?.in !== undefined && !where.id.in.includes(d.id)) return false
  if (where.analysisStatus !== undefined && d.analysisStatus !== where.analysisStatus) return false
  if (where.extractionStatus !== undefined && d.extractionStatus !== where.extractionStatus) return false
  if (where.updatedAt?.lt !== undefined && !(d.updatedAt.getTime() < where.updatedAt.lt.getTime())) return false
  return true
}

function mockDb(docs: DocRow[]) {
  const findCalls: Array<{ where: any; select: any }> = []
  const updateCalls: Array<{ where: any; data: any }> = []
  const db = {
    opportunityDocument: {
      findMany: async (args: { where: any; select: any }) => {
        findCalls.push(args)
        return docs.filter((d) => matches(d, args.where)).map((d) => ({ id: d.id }))
      },
      updateMany: async (args: { where: any; data: any }) => {
        updateCalls.push(args)
        let count = 0
        for (const d of docs) {
          if (matches(d, args.where)) {
            Object.assign(d, args.data)
            // Simulate Prisma's @updatedAt: every touched row gets a fresh
            // timestamp, which would push it past any `updatedAt < cutoff`
            // filter evaluated afterwards.
            d.updatedAt = new Date(NOW)
            count++
          }
        }
        return { count }
      },
    },
  } as unknown as Parameters<typeof recoverOrphanedDocuments>[1]
  return { db, docs, findCalls, updateCalls }
}

describe('recoverOrphanedDocuments (P1-5 orphan reaper)', () => {
  it('fails analysis docs stuck IN_PROGRESS and extraction docs stuck EXTRACTING, returning counts', async () => {
    const { db, docs, findCalls, updateCalls } = mockDb([
      { id: 'a1', analysisStatus: 'IN_PROGRESS', extractionStatus: 'EXTRACTED', updatedAt: STALE },
      { id: 'a2', analysisStatus: 'IN_PROGRESS', extractionStatus: 'EXTRACTED', updatedAt: STALE },
      { id: 'e1', analysisStatus: 'COMPLETE', extractionStatus: 'EXTRACTING', updatedAt: STALE },
      { id: 'fresh', analysisStatus: 'IN_PROGRESS', extractionStatus: 'EXTRACTING', updatedAt: FRESH },
    ])
    const res = await recoverOrphanedDocuments(ORPHAN_THRESHOLD_MS, db, () => NOW)

    expect(res).toEqual({ analysisRecovered: 2, extractionRecovered: 1 })
    expect(findCalls).toHaveLength(2)
    expect(updateCalls).toHaveLength(2)

    const cutoff = new Date(NOW - ORPHAN_THRESHOLD_MS)

    // Analysis reaper: selects only IN_PROGRESS older than cutoff, then fails
    // exactly those ids.
    expect(findCalls[0].where.analysisStatus).toBe('IN_PROGRESS')
    expect(findCalls[0].where.updatedAt).toEqual({ lt: cutoff })
    expect([...updateCalls[0].where.id.in].sort()).toEqual(['a1', 'a2'])
    expect(updateCalls[0].data.analysisStatus).toBe('FAILED')
    expect(typeof updateCalls[0].data.analysisError).toBe('string')
    expect(updateCalls[0].data.analysisError.length).toBeGreaterThan(0)

    // Extraction reaper: selects only EXTRACTING older than cutoff, then fails
    // exactly those ids.
    expect(findCalls[1].where.extractionStatus).toBe('EXTRACTING')
    expect(findCalls[1].where.updatedAt).toEqual({ lt: cutoff })
    expect(updateCalls[1].where.id.in).toEqual(['e1'])
    expect(updateCalls[1].data.extractionStatus).toBe('FAILED')
    expect(typeof updateCalls[1].data.extractionError).toBe('string')

    // A running document inside the threshold is left alone.
    const fresh = docs.find((d) => d.id === 'fresh')
    expect(fresh?.analysisStatus).toBe('IN_PROGRESS')
    expect(fresh?.extractionStatus).toBe('EXTRACTING')
  })

  it('respects a custom threshold when computing the cutoff', async () => {
    const { db, findCalls } = mockDb([])
    const res = await recoverOrphanedDocuments(60_000, db, () => NOW)
    expect(res).toEqual({ analysisRecovered: 0, extractionRecovered: 0 })
    expect(findCalls[0].where.updatedAt.lt).toEqual(new Date(NOW - 60_000))
    expect(findCalls[1].where.updatedAt.lt).toEqual(new Date(NOW - 60_000))
  })

  it('only targets running states, never terminal ones (no accidental reaping of COMPLETE/FAILED/EXTRACTED)', async () => {
    const { db, docs, findCalls, updateCalls } = mockDb([
      { id: 'done', analysisStatus: 'COMPLETE', extractionStatus: 'EXTRACTED', updatedAt: STALE },
      { id: 'failed', analysisStatus: 'FAILED', extractionStatus: 'FAILED', updatedAt: STALE },
    ])
    const res = await recoverOrphanedDocuments(ORPHAN_THRESHOLD_MS, db, () => NOW)

    expect(res).toEqual({ analysisRecovered: 0, extractionRecovered: 0 })
    expect(findCalls[0].where.analysisStatus).toBe('IN_PROGRESS')
    expect(findCalls[1].where.extractionStatus).toBe('EXTRACTING')
    // The mutation must move running docs OUT of the running state, to FAILED.
    expect(updateCalls[0].data.analysisStatus).toBe('FAILED')
    expect(updateCalls[1].data.extractionStatus).toBe('FAILED')
    // Terminal docs are untouched.
    expect(updateCalls[0].where.id.in).toEqual([])
    expect(updateCalls[1].where.id.in).toEqual([])
    expect(docs.find((d) => d.id === 'done')?.analysisStatus).toBe('COMPLETE')
    expect(docs.find((d) => d.id === 'done')?.extractionStatus).toBe('EXTRACTED')
  })

  it('recovers a document orphaned in BOTH states in one run (analysis reaper @updatedAt bump must not hide it from the extraction reaper)', async () => {
    const { db, docs } = mockDb([
      { id: 'dual', analysisStatus: 'IN_PROGRESS', extractionStatus: 'EXTRACTING', updatedAt: STALE },
    ])
    const res = await recoverOrphanedDocuments(ORPHAN_THRESHOLD_MS, db, () => NOW)

    // Regression: the analysis updateMany bumps updatedAt to NOW on the row,
    // so a cutoff-filtered extraction updateMany would no longer match it and
    // the document would spin at EXTRACTING forever. Both states must land on
    // FAILED in a single pass.
    expect(res).toEqual({ analysisRecovered: 1, extractionRecovered: 1 })
    const dual = docs.find((d) => d.id === 'dual')
    expect(dual?.analysisStatus).toBe('FAILED')
    expect(dual?.extractionStatus).toBe('FAILED')
    expect(typeof dual?.analysisError).toBe('string')
    expect(typeof dual?.extractionError).toBe('string')
  })
})
