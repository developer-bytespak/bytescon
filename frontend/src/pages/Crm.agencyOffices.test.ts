// B22 — an agency card lists the offices it counts, under any merged spelling.
import { describe, it, expect } from 'vitest'
import { officeBelongsTo } from './Crm'

const card = { agencyName: 'Department of Energy', agencyNames: ['Department of Energy', 'DEPARTMENT OF ENERGY'], officeCount: 2, contactCount: 0, activityCount: 0, lastActivityAt: null }

describe('officeBelongsTo', () => {
  it('matches every spelling merged into the card', () => {
    expect(officeBelongsTo({ agencyName: 'DEPARTMENT OF ENERGY' }, card)).toBe(true)
    expect(officeBelongsTo({ agencyName: 'Department of Energy' }, card)).toBe(true)
  })

  it('does not match another agency', () => {
    expect(officeBelongsTo({ agencyName: 'GSA' }, card)).toBe(false)
  })

  it('falls back to the card name', () => {
    expect(officeBelongsTo({ agencyName: 'GSA' }, { ...card, agencyName: 'GSA', agencyNames: undefined })).toBe(true)
  })
})
