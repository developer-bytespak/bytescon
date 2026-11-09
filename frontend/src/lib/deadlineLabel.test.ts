import { describe, it, expect } from 'vitest'
import { deadlineLabelOf } from './deadlineLabel'

describe('deadlineLabelOf', () => {
  it('returns the label a notice carries instead of a real deadline', () => {
    expect(deadlineLabelOf({ sourceMetadata: { deadlineLabel: 'Forecast: not open yet' } })).toBe('Forecast: not open yet')
  })
  it('returns null for notices with a real deadline or no metadata', () => {
    expect(deadlineLabelOf({ sourceMetadata: { deadlineLabel: null } })).toBeNull()
    expect(deadlineLabelOf({ sourceMetadata: null })).toBeNull()
    expect(deadlineLabelOf({})).toBeNull()
    expect(deadlineLabelOf(null)).toBeNull()
  })
})
