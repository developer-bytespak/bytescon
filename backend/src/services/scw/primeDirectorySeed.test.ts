import { describe, it, expect, vi } from 'vitest'
import {
  directoryRecordToCapturable,
  seedPrimeDirectoryContacts,
} from './primeDirectorySeed'
import { PRIME_SBLO_DIRECTORY, PrimeSbloRecord } from '../../data/primeSbloDirectory'
import { normalizeDedupeKey, isValidEmail } from './subcontractContacts'

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const record = (over: Partial<PrimeSbloRecord> = {}): PrimeSbloRecord => ({
  sourceKey: 'dla_captains_of_industry',
  sourceLabel: 'DLA Strategic Subcontracting OEM POCs',
  sourceUrl: 'https://www.dla.mil/example.xlsx',
  published: '2024-04-08',
  retrieved: '2026-07-29',
  agency: 'DLA',
  prime: 'Boeing',
  pocName: 'Janelle Turner',
  pocTitle: null,
  phone: '314-777-8607',
  email: 'Janelle.p.turner@boeing.com',
  ...over,
})

describe('directoryRecordToCapturable', () => {
  it('maps a directory row onto the pool capture DTO', () => {
    const out = directoryRecordToCapturable(record(), 'firm-1')

    expect(out).toEqual({
      consultingFirmId: 'firm-1',
      primeContractor: 'Boeing',
      contactName: 'Janelle Turner',
      contactEmail: 'Janelle.p.turner@boeing.com',
      contactPhone: '314-777-8607',
      agency: 'DLA',
      sourceUrl: 'https://www.dla.mil/example.xlsx',
      source: 'dla_captains_of_industry',
    })
  })

  it('leaves NAICS and set-aside unset — neither source document publishes them', () => {
    const out = directoryRecordToCapturable(record(), 'firm-1')
    expect(out.naicsCode).toBeUndefined()
    expect(out.setAside).toBeUndefined()
  })

  it('carries no opportunity reference — a directory POC is a standing contact', () => {
    const out = directoryRecordToCapturable(record(), 'firm-1')
    expect(out.opportunityId).toBeUndefined()
    expect(out.opportunityTitle).toBeUndefined()
  })

  it('passes nulls through rather than inventing values', () => {
    const out = directoryRecordToCapturable(
      record({ phone: null, agency: null, sourceUrl: null }),
      'firm-1'
    )
    expect(out.contactPhone).toBeNull()
    expect(out.agency).toBeNull()
    expect(out.sourceUrl).toBeNull()
  })
})

describe('seedPrimeDirectoryContacts', () => {
  it('captures every record and tallies created vs merged vs skipped', async () => {
    const records = [
      record({ prime: 'A', email: 'a@x.com' }),
      record({ prime: 'B', email: 'b@x.com' }),
      record({ prime: 'C', email: 'c@x.com' }),
    ]
    const capture = vi
      .fn()
      .mockResolvedValueOnce({ created: true })
      .mockResolvedValueOnce({ created: false })
      .mockResolvedValueOnce(null)

    const result = await seedPrimeDirectoryContacts('firm-1', { records, capture })

    expect(capture).toHaveBeenCalledTimes(3)
    expect(result).toEqual({ attempted: 3, created: 1, merged: 1, skipped: 1 })
  })

  it('scopes every capture to the requested tenant', async () => {
    const capture = vi.fn().mockResolvedValue({ created: true })
    await seedPrimeDirectoryContacts('firm-42', { records: [record(), record({ prime: 'X' })], capture })

    for (const call of capture.mock.calls) {
      expect(call[0].consultingFirmId).toBe('firm-42')
    }
  })

  it('filters to the requested source keys', async () => {
    const records = [
      record({ sourceKey: 'dla_captains_of_industry', prime: 'A' }),
      record({ sourceKey: 'dod_csp_prime_directory', prime: 'B' }),
    ]
    const capture = vi.fn().mockResolvedValue({ created: true })

    const result = await seedPrimeDirectoryContacts('firm-1', {
      records,
      capture,
      sourceKeys: ['dod_csp_prime_directory'],
    })

    expect(result.attempted).toBe(1)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture.mock.calls[0][0].primeContractor).toBe('B')
  })

  it('treats an empty sourceKeys array as "no filter" rather than "seed nothing"', async () => {
    const capture = vi.fn().mockResolvedValue({ created: true })
    const result = await seedPrimeDirectoryContacts('firm-1', {
      records: [record(), record({ prime: 'B' })],
      capture,
      sourceKeys: [],
    })
    expect(result.attempted).toBe(2)
  })

  it('is a no-op when the corpus has no matching source', async () => {
    const capture = vi.fn()
    const result = await seedPrimeDirectoryContacts('firm-1', {
      records: [record()],
      capture,
      sourceKeys: ['nope'],
    })
    expect(capture).not.toHaveBeenCalled()
    expect(result).toEqual({ attempted: 0, created: 0, merged: 0, skipped: 0 })
  })
})

describe('baked PRIME_SBLO_DIRECTORY corpus', () => {
  it('is non-empty and covers both published sources', () => {
    expect(PRIME_SBLO_DIRECTORY.length).toBeGreaterThan(0)
    const keys = new Set(PRIME_SBLO_DIRECTORY.map((r) => r.sourceKey))
    expect(keys.has('dla_captains_of_industry')).toBe(true)
    expect(keys.has('dod_csp_prime_directory')).toBe(true)
  })

  it('every record is capturable — the pool drops rows with no email and no name', () => {
    for (const r of PRIME_SBLO_DIRECTORY) {
      const key = normalizeDedupeKey({
        contactEmail: r.email,
        primeContractor: r.prime,
        contactName: r.pocName,
      })
      expect(key, `uncapturable record: ${r.prime} / ${r.pocName}`).not.toBeNull()
    }
  })

  it('stores only syntactically valid emails (null, never a malformed string)', () => {
    for (const r of PRIME_SBLO_DIRECTORY) {
      if (r.email !== null) {
        expect(isValidEmail(r.email), `bad email for ${r.prime}: ${r.email}`).toBe(true)
      }
    }
  })

  it('carries row-level provenance so a stale entry stays attributable', () => {
    for (const r of PRIME_SBLO_DIRECTORY) {
      expect(r.sourceKey).toBeTruthy()
      expect(r.sourceUrl).toBeTruthy()
      expect(r.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('has no duplicate (source, prime, contact) rows', () => {
    const keys = PRIME_SBLO_DIRECTORY.map(
      (r) => `${r.sourceKey}|${r.prime.toLowerCase()}|${(r.email ?? r.pocName ?? '').toLowerCase()}`
    )
    expect(new Set(keys).size).toBe(keys.length)
  })
})
