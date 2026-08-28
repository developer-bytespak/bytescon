import { describe, it, expect } from 'vitest'
import { normalizeUrl } from './url'

describe('normalizeUrl', () => {
  it('returns empty string for null, undefined, empty, or whitespace input', () => {
    expect(normalizeUrl(null)).toBe('')
    expect(normalizeUrl(undefined)).toBe('')
    expect(normalizeUrl('')).toBe('')
    expect(normalizeUrl('   ')).toBe('')
    expect(normalizeUrl('\t\n')).toBe('')
  })

  it('prepends https:// to bare domains', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('sub.example.com')).toBe('https://sub.example.com')
    expect(normalizeUrl('example.com/path?q=1')).toBe('https://example.com/path?q=1')
  })

  it('preserves an existing http:// or https:// scheme', () => {
    expect(normalizeUrl('http://example.com')).toBe('http://example.com')
    expect(normalizeUrl('https://example.com')).toBe('https://example.com')
    expect(normalizeUrl('https://example.com/path')).toBe('https://example.com/path')
  })

  it('detects existing scheme case-insensitively', () => {
    expect(normalizeUrl('HTTPS://example.com')).toBe('HTTPS://example.com')
    expect(normalizeUrl('Http://example.com')).toBe('Http://example.com')
  })

  it('trims surrounding whitespace before evaluating scheme', () => {
    expect(normalizeUrl('  example.com  ')).toBe('https://example.com')
    expect(normalizeUrl('\thttps://example.com\n')).toBe('https://example.com')
  })
})
