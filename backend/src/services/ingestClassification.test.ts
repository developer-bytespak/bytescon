// =============================================================
// Ingestion classification helpers — manual protection + cancellation detection.
// =============================================================
import { describe, it, expect } from 'vitest'
import { isManualProtected, isCancellationNotice } from './ingestClassification'

describe('isManualProtected', () => {
  it('protects only MANUAL-sourced records from ingestion overwrite', () => {
    expect(isManualProtected('MANUAL')).toBe(true)
    expect(isManualProtected('SAM_GOV')).toBe(false)
    expect(isManualProtected('DEMO')).toBe(false)
    expect(isManualProtected(null)).toBe(false)
    expect(isManualProtected(undefined)).toBe(false)
  })
})

describe('isCancellationNotice', () => {
  it('detects cancellation notice types (case-insensitive)', () => {
    expect(isCancellationNotice('Cancellation')).toBe(true)
    expect(isCancellationNotice('Notice of Cancel')).toBe(true)
    expect(isCancellationNotice('CANCELLED')).toBe(true)
    expect(isCancellationNotice('Solicitation')).toBe(false)
    expect(isCancellationNotice(null)).toBe(false)
  })
})
