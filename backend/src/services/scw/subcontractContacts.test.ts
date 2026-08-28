// =============================================================
// SubcontractContact service tests — DB fully mocked (no Postgres).
//
// prisma.subcontractContact.{upsert,deleteMany} and the logger are
// replaced with spies so capture/prune logic is exercised in isolation.
// =============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../config/database', () => ({
  prisma: {
    subcontractContact: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}))

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import { prisma } from '../../config/database'
import {
  normalizeDedupeKey,
  isValidEmail,
  captureContact,
  pruneContacts,
  DEFAULT_STALE_MONTHS,
} from './subcontractContacts'

const upsert = prisma.subcontractContact.upsert as unknown as ReturnType<typeof vi.fn>
const deleteMany = prisma.subcontractContact.deleteMany as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
})

describe('isValidEmail', () => {
  it('accepts a well-formed address', () => {
    expect(isValidEmail('a@b.co')).toBe(true)
  })

  it('rejects null / empty', () => {
    expect(isValidEmail(null)).toBe(false)
    expect(isValidEmail(undefined)).toBe(false)
    expect(isValidEmail('')).toBe(false)
  })

  it('rejects an address with no @', () => {
    expect(isValidEmail('noatsign')).toBe(false)
  })

  it('rejects an address with no TLD dot', () => {
    expect(isValidEmail('a@b')).toBe(false)
  })
})

describe('normalizeDedupeKey', () => {
  it('keys on a normalized (lowercased, trimmed) email when present', () => {
    const key = normalizeDedupeKey({
      contactEmail: '  Jane@Prime.COM ',
      primeContractor: 'Acme Corp',
      contactName: 'Jane Doe',
    })
    expect(key).toBe('email:jane@prime.com')
  })

  it('falls back to a prime|name slug when there is no email', () => {
    const key = normalizeDedupeKey({
      contactEmail: null,
      primeContractor: 'Acme Corp',
      contactName: 'Jane Doe',
    })
    expect(key).toBe('name:acme-corp|jane-doe')
  })

  it('normalizes whitespace and case into the slug', () => {
    const key = normalizeDedupeKey({
      primeContractor: '  ACME   Corp  ',
      contactName: ' Jane  DOE ',
    })
    expect(key).toBe('name:acme-corp|jane-doe')
  })

  it('returns null when there is no email and no name', () => {
    expect(
      normalizeDedupeKey({ contactEmail: null, primeContractor: 'Acme Corp', contactName: null }),
    ).toBeNull()
  })

  it('falls back to the slug when the email is invalid', () => {
    const key = normalizeDedupeKey({
      contactEmail: 'not-an-email',
      primeContractor: 'Acme Corp',
      contactName: 'Jane Doe',
    })
    expect(key).toBe('name:acme-corp|jane-doe')
  })
})

describe('captureContact', () => {
  it('returns null and never touches the DB when there is no email and no name', async () => {
    const result = await captureContact({
      consultingFirmId: 'firm-1',
      primeContractor: 'Acme Corp',
    })
    expect(result).toBeNull()
    expect(upsert).not.toHaveBeenCalled()
  })

  it('upserts once with the compound key and hasValidEmail=true for a valid email', async () => {
    const ts = new Date(0)
    upsert.mockResolvedValue({ createdAt: ts, lastSeenAt: ts })

    const result = await captureContact({
      consultingFirmId: 'firm-1',
      primeContractor: 'Acme Corp',
      contactName: 'Jane Doe',
      contactEmail: 'jane@prime.com',
    })

    expect(upsert).toHaveBeenCalledTimes(1)
    const arg = upsert.mock.calls[0][0]
    expect(arg.where.consultingFirmId_dedupeKey).toEqual({
      consultingFirmId: 'firm-1',
      dedupeKey: 'email:jane@prime.com',
    })
    expect(arg.create.hasValidEmail).toBe(true)
    // createdAt === lastSeenAt -> this sighting created the row.
    expect(result).toEqual({ created: true })
  })

  it('reports created=false when the row already existed (createdAt != lastSeenAt)', async () => {
    upsert.mockResolvedValue({
      createdAt: new Date(0),
      lastSeenAt: new Date(1000),
    })

    const result = await captureContact({
      consultingFirmId: 'firm-1',
      primeContractor: 'Acme Corp',
      contactName: 'Jane Doe',
      contactEmail: 'jane@prime.com',
    })

    expect(result).toEqual({ created: false })
  })

  it('swallows upsert errors and returns null', async () => {
    upsert.mockRejectedValue(new Error('db down'))

    const result = await captureContact({
      consultingFirmId: 'firm-1',
      primeContractor: 'Acme Corp',
      contactName: 'Jane Doe',
      contactEmail: 'jane@prime.com',
    })

    expect(result).toBeNull()
    expect(upsert).toHaveBeenCalledTimes(1)
  })
})

describe('pruneContacts', () => {
  it('returns junk + stale counts and calls deleteMany twice', async () => {
    deleteMany.mockResolvedValueOnce({ count: 3 }).mockResolvedValueOnce({ count: 2 })

    const result = await pruneContacts()

    expect(result).toEqual({ junkDeleted: 3, staleDeleted: 2 })
    expect(deleteMany).toHaveBeenCalledTimes(2)
  })

  it('scopes both deletes to the tenant when consultingFirmId is passed', async () => {
    deleteMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 0 })

    await pruneContacts({ consultingFirmId: 'firm-1' })

    expect(deleteMany).toHaveBeenCalledTimes(2)
    const junkWhere = deleteMany.mock.calls[0][0].where
    const staleWhere = deleteMany.mock.calls[1][0].where
    expect(junkWhere.consultingFirmId).toBe('firm-1')
    expect(staleWhere.consultingFirmId).toBe('firm-1')
  })

  it('derives a stale cutoff from staleMonths (default available)', async () => {
    deleteMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 0 })
    const now = new Date('2026-06-13T00:00:00Z')

    await pruneContacts({ staleMonths: DEFAULT_STALE_MONTHS, now })

    const staleWhere = deleteMany.mock.calls[1][0].where
    const expectedCutoff = new Date(
      now.getTime() - DEFAULT_STALE_MONTHS * 30 * 24 * 60 * 60 * 1000,
    )
    expect(staleWhere.lastSeenAt.lt.getTime()).toBe(expectedCutoff.getTime())
    expect(staleWhere.timesSeen).toEqual({ lte: 1 })
  })
})
