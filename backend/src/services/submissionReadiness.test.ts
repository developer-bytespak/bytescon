// =============================================================
// Submission readiness + document validation — pure, deterministic.
// =============================================================
import { describe, it, expect } from 'vitest'
import { computeReadiness, validateDocumentItem } from './submissionReadiness'

describe('computeReadiness', () => {
  it('separates completion % from readiness and blocks on incomplete mandatory items', () => {
    const r = computeReadiness([
      { status: 'COMPLETE', isMandatory: true, isBlocker: false },
      { status: 'PENDING', isMandatory: true, isBlocker: false },
      { status: 'COMPLETE', isMandatory: false, isBlocker: false },
    ])
    expect(r.overallPercent).toBe(67) // 2/3
    expect(r.mandatoryPercent).toBe(50) // 1/2
    expect(r.canBeReady).toBe(false)
    expect(r.blockingReasons.join(' ')).toMatch(/mandatory/)
  })
  it('blocks readiness on an unresolved blocker even at full mandatory completion', () => {
    const r = computeReadiness([
      { status: 'COMPLETE', isMandatory: true, isBlocker: false },
      { status: 'BLOCKED', isMandatory: false, isBlocker: true },
    ])
    expect(r.mandatoryPercent).toBe(100)
    expect(r.blockerCount).toBe(1)
    expect(r.canBeReady).toBe(false)
  })
  it('is ready when all mandatory complete and no blockers', () => {
    const r = computeReadiness([
      { status: 'COMPLETE', isMandatory: true, isBlocker: false },
      { status: 'VALIDATED', isMandatory: true, isBlocker: false },
      { status: 'NA', isMandatory: false, isBlocker: false },
    ])
    expect(r.canBeReady).toBe(true)
    expect(r.overallPercent).toBe(100)
  })
  it('counts overdue incomplete items', () => {
    const past = new Date(Date.now() - 86_400_000)
    const r = computeReadiness([{ status: 'PENDING', isMandatory: true, isBlocker: false, dueDate: past }])
    expect(r.overdueCount).toBe(1)
  })
})

describe('validateDocumentItem', () => {
  it('fails a required document with no attachment', () => {
    expect(validateDocumentItem({ itemType: 'DOCUMENT', attachmentKey: null, attachmentName: null, fileExists: false }).state).toBe('FAILED')
  })
  it('passes a present PDF matching the expected extension', () => {
    const r = validateDocumentItem({ itemType: 'DOCUMENT', attachmentKey: 'k', attachmentName: 'Vol1.pdf', fileExists: true, expectedExtensions: ['pdf'] })
    expect(r.state).toBe('PASSED')
  })
  it('fails on wrong file type', () => {
    const r = validateDocumentItem({ itemType: 'DOCUMENT', attachmentKey: 'k', attachmentName: 'Vol1.docx', fileExists: true, expectedExtensions: ['pdf'] })
    expect(r.state).toBe('FAILED')
  })
  it('reports MANUAL_REQUIRED for signature checks it cannot read', () => {
    const r = validateDocumentItem({ itemType: 'SIGNATURE', attachmentKey: 'k', attachmentName: 'signed.pdf', fileExists: true })
    expect(r.state).toBe('MANUAL_REQUIRED')
  })
})
