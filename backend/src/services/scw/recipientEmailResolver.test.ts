import { describe, it, expect } from 'vitest'
import { EmailVerificationStatus } from '@prisma/client'
import type { ContactRow } from '../contactProviders'
import {
  resolveRecipientEmail,
  canAutoSend,
  isEmailEnrichmentEnabled,
} from './recipientEmailResolver'

const contact = (overrides: Partial<ContactRow> = {}): ContactRow => ({
  name: null,
  title: null,
  email: null,
  phone: null,
  source: 'sam.gov',
  ...overrides,
})

describe('resolveRecipientEmail', () => {
  it('returns a verified email and allows auto-send', () => {
    const r = resolveRecipientEmail([
      contact({ name: 'Jane Doe', email: 'jane@prime.com', verificationStatus: 'verified', source: 'apollo' }),
    ])
    expect(r.email).toBe('jane@prime.com')
    expect(r.status).toBe(EmailVerificationStatus.verified)
    expect(r.source).toBe('apollo')
    expect(r.contactName).toBe('Jane Doe')
    expect(canAutoSend(r.status)).toBe(true)
  })

  it('treats an email with no explicit status as probable and blocks auto-send', () => {
    const r = resolveRecipientEmail([contact({ email: 'bd@prime.com' })])
    expect(r.email).toBe('bd@prime.com')
    expect(r.status).toBe(EmailVerificationStatus.probable)
    expect(canAutoSend(r.status)).toBe(false)
  })

  it('honors an explicit probable status (e.g. SAM POC) and blocks auto-send', () => {
    const r = resolveRecipientEmail([
      contact({ email: 'poc@prime.com', verificationStatus: 'probable', source: 'sam.gov' }),
    ])
    expect(r.status).toBe(EmailVerificationStatus.probable)
    expect(canAutoSend(r.status)).toBe(false)
  })

  it('returns the explicit missing state when no contact has an email', () => {
    const r = resolveRecipientEmail([contact({ name: 'No Email POC' }), contact({})])
    expect(r.email).toBeNull()
    expect(r.status).toBe(EmailVerificationStatus.unknown)
    expect(r.source).toBeNull()
    expect(canAutoSend(r.status)).toBe(false)
  })

  it('returns the missing state for an empty contact list', () => {
    const r = resolveRecipientEmail([])
    expect(r.email).toBeNull()
    expect(r.status).toBe(EmailVerificationStatus.unknown)
  })

  it('prefers a verified address over a probable one', () => {
    const r = resolveRecipientEmail([
      contact({ email: 'maybe@prime.com', verificationStatus: 'probable' }),
      contact({ email: 'sure@prime.com', verificationStatus: 'verified' }),
    ])
    expect(r.email).toBe('sure@prime.com')
    expect(r.status).toBe(EmailVerificationStatus.verified)
  })

  it('prefers a named contact when verification status ties', () => {
    const r = resolveRecipientEmail([
      contact({ email: 'generic@prime.com', verificationStatus: 'probable' }),
      contact({ name: 'Pat Lee', email: 'pat@prime.com', verificationStatus: 'probable' }),
    ])
    expect(r.email).toBe('pat@prime.com')
    expect(r.contactName).toBe('Pat Lee')
  })

  it('ignores malformed emails without an @', () => {
    const r = resolveRecipientEmail([contact({ email: 'not-an-email' })])
    expect(r.email).toBeNull()
    expect(r.status).toBe(EmailVerificationStatus.unknown)
  })
})

describe('isEmailEnrichmentEnabled', () => {
  const orig = process.env.SCW_EMAIL_ENRICHMENT_ENABLED
  const restore = () => {
    if (orig !== undefined) process.env.SCW_EMAIL_ENRICHMENT_ENABLED = orig
    else delete process.env.SCW_EMAIL_ENRICHMENT_ENABLED
  }

  it('is off by default / when unset', () => {
    delete process.env.SCW_EMAIL_ENRICHMENT_ENABLED
    expect(isEmailEnrichmentEnabled()).toBe(false)
    restore()
  })

  it('is on for truthy values', () => {
    for (const v of ['1', 'true', 'yes', 'TRUE']) {
      process.env.SCW_EMAIL_ENRICHMENT_ENABLED = v
      expect(isEmailEnrichmentEnabled()).toBe(true)
    }
    restore()
  })
})
