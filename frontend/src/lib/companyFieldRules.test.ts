import { describe, it, expect } from 'vitest'
import * as rules from './companyFieldRules'

describe('company field rules', () => {
  it('requires a UEI of exactly 12 letters or digits, saying how many were typed', () => {
    expect(rules.uei('')).toBeNull()
    expect(rules.uei('J7M9HPTGJ1S8')).toBeNull()
    expect(rules.uei('J7M9HPTGJ1')).toBe('UEI must be exactly 12 characters (you have 10)')
    expect(rules.uei('J7M9-HPTGJ1S')).toBe('UEI can only contain letters and digits')
  })

  it('requires a CAGE code of exactly 5 letters or digits', () => {
    expect(rules.cage('9ARK1')).toBeNull()
    expect(rules.cage('9ARK')).toBe('CAGE code must be exactly 5 characters (you have 4)')
  })

  it('names the NAICS and PSC codes that are wrong', () => {
    expect(rules.naicsList('238210, 54')).toBeNull()
    expect(rules.naicsList('238210, 23821A, 1')).toBe('NAICS codes are 2 to 6 digits — check 23821A, 1')
    expect(rules.pscList('Z2AA, N059')).toBeNull()
    expect(rules.pscList('Z2A')).toBe('PSC codes are 4 letters or digits — check Z2A')
  })

  it('checks ZIP, phone and website formats', () => {
    expect(rules.zip('78701')).toBeNull()
    expect(rules.zip('78701-1234')).toBeNull()
    expect(rules.zip('7870')).not.toBeNull()
    expect(rules.phone('(512) 555-0100')).toBeNull()
    expect(rules.phone('555-0100')).toBe('Phone must have 10 to 15 digits (you have 7)')
    expect(rules.phone('call me')).not.toBeNull()
    expect(rules.website('ark.test')).toBeNull()
    expect(rules.website('https://www.ark.test/about')).toBeNull()
    expect(rules.website('ark')).not.toBeNull()
  })

  it('checks names and numbers', () => {
    expect(rules.companyName(' ')).toBe('Company name is required')
    expect(rules.companyName('A')).toBe('Company name must be at least 2 characters')
    expect(rules.wholeNumber('Employee count')('1,200')).toBeNull()
    expect(rules.wholeNumber('Employee count')('12.5')).toBe('Employee count must be a whole number')
    expect(rules.dollars('Revenue')('$4,500,000.50')).toBeNull()
    expect(rules.dollars('Revenue')('lots')).not.toBeNull()
  })

  it('returns only the fields with an error', () => {
    expect(rules.checkAll({ a: 'J7M9', b: '78701' }, { a: rules.uei, b: rules.zip })).toEqual({ a: 'UEI must be exactly 12 characters (you have 4)' })
  })
})
