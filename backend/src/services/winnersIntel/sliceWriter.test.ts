// Winners Intel knowledge files must survive a restart, the way uploads do: the
// local folder is a cache that hosts wipe, and the bucket is the real copy.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'

// The storage root comes from the working directory at import time, so point it
// at a temp folder before anything loads. Real dev slices are never touched.
const tmp = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('fs'), { join } = require('path'), { tmpdir } = require('os')
  const dir = mkdtempSync(join(tmpdir(), 'winners-slices-'))
  process.cwd = () => dir
  return dir as string
})
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { setRemoteFileStore } from '../fileStorage'
import { readManifest, readSlice, writeSlices } from './sliceWriter'
import type { DistillationOutput, PrimeWinnerSlice } from './distill'

const bucket = new Map<string, Buffer>()
const slice = (over: Partial<PrimeWinnerSlice>): PrimeWinnerSlice => ({
  sliceKey: 'global', sliceKind: 'global', windowStart: '2025-01-01', windowEnd: '2026-01-01', awardCount: 3, totalObligation: 1000,
  contractValueDistribution: { p10: 1, p25: 2, p50: 3, p75: 4, p90: 5, p99: 6 },
  competitionProfile: { fullAndOpenPct: 0.5, soleSourcePct: 0.25, oneBidPct: 0.25, avgOffersReceived: 2 },
  setAsideUtilization: {}, topAwardingOffices: [], topRecipients: [], geographyPattern: { topPlaceOfPerformanceStates: [] },
  pricingPatterns: { avgBaseToTotalRatio: null, avgPopMonths: null }, refreshBatchId: 'batch-1', generatedAt: '2026-01-02T00:00:00Z',
  ...over,
})
const output = (naics: string[]): DistillationOutput => ({
  global: slice({}),
  byAgency: [slice({ sliceKey: 'agency:9700', sliceKind: 'agency', agencyToptierCode: '9700', agencyToptierName: 'Department of Defense' })],
  byNaics: naics.map((n) => slice({ sliceKey: `naics:${n}`, sliceKind: 'naics', naics: n })),
  windowStart: '2025-01-01', windowEnd: '2026-01-01',
} as DistillationOutput)
const wipeDisk = () => fs.rmSync(path.join(tmp, 'uploads'), { recursive: true, force: true })

beforeEach(() => {
  bucket.clear()
  wipeDisk()
  setRemoteFileStore({
    put: async (key: string, data: Buffer) => { bucket.set(key, Buffer.from(data)) },
    get: async (key: string) => bucket.get(key) ?? null,
    delete: async (key: string) => { bucket.delete(key) },
  } as never)
})
afterAll(() => {
  setRemoteFileStore(null)
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('Winners Intel slices', () => {
  it('keeps every slice and the manifest in the bucket', async () => {
    await writeSlices(output(['541512']))
    expect([...bucket.keys()].sort()).toEqual([
      'uploads/winners/_global.md', 'uploads/winners/_manifest.json', 'uploads/winners/by-department/9700.md', 'uploads/winners/by-naics/541512.md',
    ])
  })

  it('comes back after the disk is wiped', async () => {
    await writeSlices(output(['541512']))
    wipeDisk()

    const manifest = await readManifest()
    expect(manifest?.slices).toHaveLength(3)
    const naics = manifest!.slices.find((s) => s.sliceKind === 'naics')!
    expect(await readSlice(naics)).toContain('541512')
  })

  it('removes slices that fell out of the new refresh', async () => {
    await writeSlices(output(['541512', '541511']))
    await writeSlices(output(['541512']))
    expect(bucket.has('uploads/winners/by-naics/541511.md')).toBe(false)
    expect(bucket.has('uploads/winners/by-naics/541512.md')).toBe(true)
    expect(fs.existsSync(path.join(tmp, 'uploads/winners/by-naics/541511.md'))).toBe(false)
  })

  it('refuses a slice whose content no longer matches its checksum', async () => {
    await writeSlices(output(['541512']))
    const manifest = await readManifest()
    const entry = manifest!.slices.find((s) => s.sliceKind === 'naics')!
    fs.writeFileSync(path.join(tmp, 'uploads/winners', entry.filePath), 'tampered')
    expect(await readSlice(entry)).toBeNull()
  })

  it('reports nothing yet when no refresh has ever run', async () => {
    expect(await readManifest()).toBeNull()
  })
})
