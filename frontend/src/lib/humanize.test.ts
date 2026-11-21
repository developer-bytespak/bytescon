import { describe, it, expect } from 'vitest'
import { humanize } from './humanize'

describe('humanize', () => {
  it('turns enum values into sentence case', () => {
    expect(humanize('NOT_EXERCISED')).toBe('Not exercised')
    expect(humanize('IN_REVIEW')).toBe('In review')
    expect(humanize('PENDING')).toBe('Pending')
  })
  it('keeps acronyms and text that is already written for people', () => {
    expect(humanize('FFP')).toBe('FFP')
    expect(humanize('SAM.gov')).toBe('SAM.gov')
    expect(humanize('Bid as sub')).toBe('Bid as sub')
    expect(humanize('NDA_SIGNED')).toBe('NDA signed')
  })
})
