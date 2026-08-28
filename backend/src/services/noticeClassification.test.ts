// =============================================================
// §6.1D — Pre-solicitation notice classification.
//
// Under test: the feed's own notice type is authoritative, the title is only a
// fallback, and the "why respond early" wording never promises influence,
// consideration or award.
// =============================================================
import { describe, it, expect } from 'vitest'
import { classifyNotice, isPresolicitationKind, PRESOLICITATION_KINDS } from './noticeClassification'

describe('classifyNotice — notice type is authoritative', () => {
  it.each([
    ['Sources Sought', 'SOURCES_SOUGHT'],
    ['Request for Information', 'RFI'],
    ['RFI', 'RFI'],
    ['Special Notice', 'SPECIAL_NOTICE'],
    ['Draft RFP', 'DRAFT_RFP'],
    ['Presolicitation', 'PRESOLICITATION'],
    ['Industry Day', 'INDUSTRY_DAY'],
    ['Pre-Proposal Conference', 'INDUSTRY_DAY'],
  ])('classifies %s as %s', (noticeType, expected) => {
    const result = classifyNotice(noticeType, 'Some title')
    expect(result.kind).toBe(expected)
    expect(result.isPreSolicitation).toBe(true)
    expect(result.basis).toBe('NOTICE_TYPE')
  })

  it('treats a released solicitation as not pre-solicitation', () => {
    const result = classifyNotice('Solicitation', 'Cyber support services')
    expect(result.kind).toBeNull()
    expect(result.isPreSolicitation).toBe(false)
    expect(result.whyEarlyResponseMayMatter).toBeNull()
  })

  it('trusts the feed over a misleading title', () => {
    // The feed says this is a released solicitation; the title mentions RFI.
    const result = classifyNotice('Solicitation', 'Response to the earlier RFI')
    expect(result.kind).toBeNull()
    expect(result.basis).toBe('NONE')
  })
})

describe('classifyNotice — title fallback', () => {
  it('falls back to the title only when no notice type exists', () => {
    const result = classifyNotice(null, 'Sources sought for enterprise IT')
    expect(result.kind).toBe('SOURCES_SOUGHT')
    expect(result.basis).toBe('TITLE')
  })

  it('reports NONE when neither source classifies', () => {
    const result = classifyNotice(null, 'Award notice for contract W15P7T')
    expect(result.kind).toBeNull()
    expect(result.basis).toBe('NONE')
    expect(result.label).toBe('Solicitation')
  })

  it('preserves an unrecognised notice type as the display label', () => {
    const result = classifyNotice('Combined Synopsis/Solicitation', null)
    expect(result.kind).toBeNull()
    expect(result.label).toBe('Combined Synopsis/Solicitation')
  })
})

describe('classifyNotice — wording never promises influence or award', () => {
  it('always disclaims a guarantee for every pre-solicitation kind', () => {
    for (const kind of PRESOLICITATION_KINDS) {
      const noticeType = kind === 'RFI' ? 'Request for Information'
        : kind === 'SOURCES_SOUGHT' ? 'Sources Sought'
        : kind === 'DRAFT_RFP' ? 'Draft RFP'
        : kind === 'INDUSTRY_DAY' ? 'Industry Day'
        : kind === 'SPECIAL_NOTICE' ? 'Special Notice'
        : 'Presolicitation'
      const result = classifyNotice(noticeType, null)
      expect(result.kind, noticeType).toBe(kind)
      expect(result.whyEarlyResponseMayMatter, kind).toMatch(/does not guarantee|does not guarantee that/i)
    }
  })

  it('never claims responding guarantees influence, consideration or award', () => {
    for (const kind of PRESOLICITATION_KINDS) {
      const result = classifyNotice(kind === 'RFI' ? 'RFI' : kind.replace(/_/g, ' '), null)
      const text = result.whyEarlyResponseMayMatter ?? ''
      expect(text).not.toMatch(/will ensure|guarantees influence|guarantees consideration|ensures award/i)
    }
  })
})

describe('classifyNotice — priority and determinism', () => {
  it('gives sources-sought and RFI a high default priority', () => {
    expect(classifyNotice('Sources Sought', null).suggestedPriority).toBe('HIGH')
    expect(classifyNotice('Request for Information', null).suggestedPriority).toBe('HIGH')
    expect(classifyNotice('Special Notice', null).suggestedPriority).toBe('LOW')
  })

  it('is deterministic', () => {
    expect(classifyNotice('Sources Sought', 'X')).toEqual(classifyNotice('Sources Sought', 'X'))
  })
})

describe('isPresolicitationKind', () => {
  it('recognises only the defined kinds', () => {
    expect(isPresolicitationKind('SOURCES_SOUGHT')).toBe(true)
    expect(isPresolicitationKind('SOLICITATION')).toBe(false)
    expect(isPresolicitationKind(null)).toBe(false)
    expect(isPresolicitationKind(undefined)).toBe(false)
  })
})
