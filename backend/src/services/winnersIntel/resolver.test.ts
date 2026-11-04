// Which knowledge goes into a proposal: the firm must have opted in, agency names
// match loosely, NAICS codes exactly, and the total stays under the token cap.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

const firmFind = vi.fn()
const readManifest = vi.fn()
const readSlice = vi.fn()
vi.mock('../../config/database', () => ({ prisma: { consultingFirm: { findUnique: (...a: unknown[]) => firmFind(...a) } } }))
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('./sliceWriter', () => ({
  readManifest: (...a: unknown[]) => readManifest(...a),
  readSlice: (...a: unknown[]) => readSlice(...a),
}))

import { resolveWinnersContext } from './resolver'

const ORIGINAL = process.env.ENABLE_WINNERS_INTEL
const entry = (sliceKey: string, sliceKind: string, over: Record<string, unknown> = {}) => ({
  sliceKey, sliceKind, filePath: `${sliceKey}.md`, sha256: 'x', bytes: 10, estimatedTokens: 1000, generatedAt: '2026-01-01', ...over,
})
const manifest = (slices: unknown[], generatedAt = new Date().toISOString()) => ({ refreshBatchId: 'b', generatedAt, slices })
const base = [
  entry('global', 'global'),
  entry('agency:9700', 'agency', { agencyToptierCode: '9700', agencyToptierName: 'Department of Defense' }),
  entry('agency:7500', 'agency', { agencyToptierCode: '7500', agencyToptierName: 'Department of Health and Human Services' }),
  entry('naics:541512', 'naics', { naics: '541512' }),
  entry('naics:236220', 'naics', { naics: '236220' }),
]
const hint = { agency: 'DEPT OF DEFENSE', naicsCode: '541512' }

beforeEach(() => {
  process.env.ENABLE_WINNERS_INTEL = 'true'
  firmFind.mockReset().mockResolvedValue({ winnersIntelOptIn: true })
  readManifest.mockReset().mockResolvedValue(manifest(base))
  readSlice.mockReset().mockImplementation(async (e: { sliceKey: string }) => `body of ${e.sliceKey}`)
})
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.ENABLE_WINNERS_INTEL
  else process.env.ENABLE_WINNERS_INTEL = ORIGINAL
})

const loaded = () => readSlice.mock.calls.map((c) => (c[0] as { sliceKey: string }).sliceKey)

describe('resolveWinnersContext', () => {
  it('does nothing when the feature is off', async () => {
    process.env.ENABLE_WINNERS_INTEL = 'false'
    expect(await resolveWinnersContext(hint, 'f1')).toBeNull()
    expect(readManifest).not.toHaveBeenCalled()
  })

  it('does nothing when the firm has not opted in', async () => {
    firmFind.mockResolvedValue({ winnersIntelOptIn: false })
    expect(await resolveWinnersContext(hint, 'f1')).toBeNull()
    expect(readManifest).not.toHaveBeenCalled()
  })

  it('does nothing before the first refresh', async () => {
    readManifest.mockResolvedValue(null)
    expect(await resolveWinnersContext(hint, 'f1')).toBeNull()
  })

  it('loads the global slice, the matching agency and the exact NAICS', async () => {
    const ctx = await resolveWinnersContext(hint, 'f1')
    expect(ctx).not.toBeNull()
    expect(loaded()).toContain('global')
    expect(loaded()).toContain('agency:9700')
    expect(loaded()).toContain('naics:541512')
    expect(loaded()).not.toContain('agency:7500')
    expect(loaded()).not.toContain('naics:236220')
  })

  it('still gives the global slice when nothing else matches', async () => {
    await resolveWinnersContext({ agency: 'Unknown Bureau of Things', naicsCode: '111111' }, 'f1')
    expect(loaded()).toEqual(['global'])
  })

  it('stops adding slices at the token cap', async () => {
    readManifest.mockResolvedValue(manifest([
      entry('global', 'global', { estimatedTokens: 7000 }),
      entry('agency:9700', 'agency', { agencyToptierCode: '9700', agencyToptierName: 'Department of Defense', estimatedTokens: 4000 }),
      entry('naics:541512', 'naics', { naics: '541512', estimatedTokens: 4000 }),
    ]))
    await resolveWinnersContext(hint, 'f1')
    expect(loaded()).toEqual(['global', 'agency:9700'])
  })

  it('skips a slice that fails to load and returns the rest', async () => {
    readSlice.mockImplementation(async (e: { sliceKey: string }) => (e.sliceKey === 'agency:9700' ? null : `body of ${e.sliceKey}`))
    const ctx = await resolveWinnersContext(hint, 'f1')
    expect(JSON.stringify(ctx)).toContain('body of global')
    expect(JSON.stringify(ctx)).not.toContain('body of agency:9700')
  })

  it('returns nothing when every selected slice fails to load', async () => {
    readSlice.mockResolvedValue(null)
    expect(await resolveWinnersContext(hint, 'f1')).toBeNull()
  })

  it('warns when the data is old', async () => {
    readManifest.mockResolvedValue(manifest(base, new Date(Date.now() - 30 * 86_400_000).toISOString()))
    expect(JSON.stringify(await resolveWinnersContext(hint, 'f1'))).toMatch(/30 days old/)
  })
})
