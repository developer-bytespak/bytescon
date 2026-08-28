// =============================================================
// recipientProfileService — mergeSupplementalContacts
//
// The corpus supplement must be strictly ADDITIVE: it appends only
// contacts the primary provider didn't already surface (deduped by email,
// or by name+phone when emailless), and returns the primary array
// untouched when it adds nothing.
// =============================================================
import { describe, it, expect, vi } from 'vitest'

vi.mock('../config/database', () => ({ prisma: {} }))
vi.mock('../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('./samEntityApi', () => ({ lookupEntityByUEI: vi.fn() }))

import { mergeSupplementalContacts } from './recipientProfileService'
import type { ContactRow } from './contactProviders'

const row = (o: Partial<ContactRow> = {}): ContactRow => ({
  name: null,
  title: null,
  email: null,
  phone: null,
  source: 'sam.gov',
  ...o,
})

describe('mergeSupplementalContacts', () => {
  it('appends a supplemental contact the primary lacks', () => {
    const primary = [row({ email: 'a@x.com', source: 'sam.gov' })]
    const supp = [row({ email: 'b@y.com', source: 'supplemental' })]
    const out = mergeSupplementalContacts(primary, supp)
    expect(out).toHaveLength(2)
    expect(out[1].source).toBe('supplemental')
  })

  it('dedupes by email case-insensitively', () => {
    const primary = [row({ email: 'Dispatch@Acme.com' })]
    const supp = [row({ email: 'dispatch@acme.com', source: 'supplemental' })]
    expect(mergeSupplementalContacts(primary, supp)).toHaveLength(1)
  })

  it('dedupes emailless rows by name+phone', () => {
    const primary = [row({ name: 'Joe', phone: '555-1' })]
    const supp = [row({ name: 'joe', phone: '555-1', source: 'supplemental' })]
    expect(mergeSupplementalContacts(primary, supp)).toHaveLength(1)
  })

  it('returns the SAME primary array (identity) when nothing is added', () => {
    const primary = [row({ email: 'a@x.com' })]
    const supp = [row({ email: 'a@x.com', source: 'supplemental' })]
    const out = mergeSupplementalContacts(primary, supp)
    expect(out).toBe(primary)
  })

  it('adds an emailless supplemental contact with a distinct name', () => {
    const primary = [row({ email: 'a@x.com', name: 'Ann' })]
    const supp = [row({ name: 'Bob', phone: '555-9', source: 'supplemental' })]
    expect(mergeSupplementalContacts(primary, supp)).toHaveLength(2)
  })
})
