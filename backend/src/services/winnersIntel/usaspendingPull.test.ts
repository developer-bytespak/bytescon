// =============================================================
// Unit tests — USAspending field extractors.
//
// Regression coverage for the "[object Object]" NAICS corruption: the
// mapper must pluck .code from the object form and reject any value that
// doesn't match the code's known shape, no matter what the API returns.
// =============================================================
import { describe, it, expect } from 'vitest'
import { extractNaicsCode, extractObjectCode } from './usaspendingPull'

describe('extractNaicsCode', () => {
  it('plucks code from the { code, description } object form', () => {
    expect(extractNaicsCode({ code: '541512', description: 'Computer Systems Design' })).toBe('541512')
  })

  it('takes the leading code from an annotated string', () => {
    expect(extractNaicsCode('541512 — Computer Systems Design')).toBe('541512')
    expect(extractNaicsCode('541512')).toBe('541512')
  })

  it('rejects objects without a code instead of coercing to "[object Object]"', () => {
    expect(extractNaicsCode({ description: 'no code here' })).toBeNull()
    expect(extractNaicsCode({})).toBeNull()
  })

  it('rejects values that do not look like a NAICS code', () => {
    expect(extractNaicsCode('[object Object]')).toBeNull()
    expect(extractNaicsCode({ code: 'not-a-code' })).toBeNull()
    expect(extractNaicsCode('1234567')).toBeNull() // 7 digits — too long
    expect(extractNaicsCode(null)).toBeNull()
    expect(extractNaicsCode(undefined)).toBeNull()
    expect(extractNaicsCode('')).toBeNull()
  })

  it('accepts 2-6 digit sector through national-industry codes', () => {
    expect(extractNaicsCode('54')).toBe('54')
    expect(extractNaicsCode({ code: 336411 })).toBe('336411')
  })
})

describe('extractObjectCode (PSC)', () => {
  it('plucks code from the object form and accepts plain strings', () => {
    expect(extractObjectCode({ code: 'R425' })).toBe('R425')
    expect(extractObjectCode('V112')).toBe('V112')
  })

  it('rejects malformed values', () => {
    expect(extractObjectCode('[object Object]')).toBeNull()
    expect(extractObjectCode({ description: 'no code' })).toBeNull()
    expect(extractObjectCode(null)).toBeNull()
    expect(extractObjectCode('')).toBeNull()
  })
})
