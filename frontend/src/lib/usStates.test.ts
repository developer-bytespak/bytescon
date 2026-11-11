import { describe, it, expect } from 'vitest'
import { US_STATES, stateOptions, toStateCode } from './usStates'

describe('US states', () => {
  it('lists the 50 states, DC and the 5 territories once each', () => {
    expect(US_STATES).toHaveLength(56)
    expect(new Set(US_STATES.map((s) => s.code)).size).toBe(56)
  })

  it('matches a code or a full name, ignoring case', () => {
    expect(toStateCode('tx')).toBe('TX')
    expect(toStateCode(' Texas ')).toBe('TX')
    expect(toStateCode('district of columbia')).toBe('DC')
    expect(toStateCode('Ontario')).toBeNull()
    expect(toStateCode('')).toBeNull()
  })

  it('keeps an unrecognised saved value as an extra choice', () => {
    expect(stateOptions('TX')).toHaveLength(56)
    expect(stateOptions('Ontario')[0]).toEqual({ value: 'Ontario', label: 'Ontario' })
    expect(stateOptions('Texas')).toHaveLength(56)
  })
})
