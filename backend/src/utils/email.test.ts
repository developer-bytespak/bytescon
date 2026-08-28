import { describe, it, expect } from 'vitest'
import { normalizeEmail, EmailField, OptionalEmailField } from './email'

describe('normalizeEmail', () => {
  it('lowercases mixed-case input', () => {
    expect(normalizeEmail('Johngladmon917@Gmail.com')).toBe('johngladmon917@gmail.com')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeEmail('  user@example.com  ')).toBe('user@example.com')
  })

  it('trims and lowercases together', () => {
    expect(normalizeEmail('  Mixed.Case@Example.COM\n')).toBe('mixed.case@example.com')
  })

  it('is idempotent — already-normalized input passes through', () => {
    expect(normalizeEmail('user@example.com')).toBe('user@example.com')
    expect(normalizeEmail(normalizeEmail('Foo@bar.com'))).toBe('foo@bar.com')
  })
})

describe('EmailField (Zod transform)', () => {
  it('accepts a valid email and returns lowercased form', () => {
    const result = EmailField.parse('John@Example.com')
    expect(result).toBe('john@example.com')
  })

  it('rejects an invalid email format', () => {
    expect(() => EmailField.parse('not-an-email')).toThrow()
  })

  it('rejects whitespace-only input', () => {
    expect(() => EmailField.parse('   ')).toThrow()
  })
})

describe('OptionalEmailField', () => {
  it('accepts undefined and returns undefined', () => {
    expect(OptionalEmailField.parse(undefined)).toBeUndefined()
  })

  it('normalizes a present value', () => {
    expect(OptionalEmailField.parse('USER@X.COM')).toBe('user@x.com')
  })

  it('rejects an invalid email when present', () => {
    expect(() => OptionalEmailField.parse('@bad')).toThrow()
  })
})
