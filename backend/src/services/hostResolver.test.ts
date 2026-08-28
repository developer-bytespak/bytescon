// =============================================================
// hostResolver — pure function tests (no DB, no network)
// Validates the regex/blocklist guards that protect tenant routing.
// =============================================================

import { describe, it, expect } from 'vitest'
import {
  isValidSubdomain,
  isValidHost,
  buildPortalUrl,
  PLATFORM_ROOT_DOMAIN,
} from './hostResolver'

describe('isValidSubdomain', () => {
  it('accepts standard slugs', () => {
    expect(isValidSubdomain('acme')).toBe(true)
    expect(isValidSubdomain('acme-federal')).toBe(true)
    expect(isValidSubdomain('mr-govcon-123')).toBe(true)
    expect(isValidSubdomain('a1')).toBe(true)
  })

  it('rejects reserved subdomains', () => {
    expect(isValidSubdomain('www')).toBe(false)
    expect(isValidSubdomain('app')).toBe(false)
    expect(isValidSubdomain('api')).toBe(false)
    expect(isValidSubdomain('admin')).toBe(false)
    expect(isValidSubdomain('portal')).toBe(false)
  })

  it('rejects too short or too long', () => {
    expect(isValidSubdomain('a')).toBe(false) // too short
    expect(isValidSubdomain('a'.repeat(64))).toBe(false) // too long
  })

  it('rejects leading/trailing hyphens', () => {
    expect(isValidSubdomain('-acme')).toBe(false)
    expect(isValidSubdomain('acme-')).toBe(false)
  })

  it('rejects invalid characters', () => {
    expect(isValidSubdomain('acme.federal')).toBe(false) // dot not allowed
    expect(isValidSubdomain('acme_federal')).toBe(false) // underscore
    expect(isValidSubdomain('Acme')).toBe(false) // uppercase
    expect(isValidSubdomain('acme!')).toBe(false)
    expect(isValidSubdomain('')).toBe(false)
  })
})

describe('isValidHost', () => {
  it('accepts standard hostnames', () => {
    expect(isValidHost('bytescon.com')).toBe(true)
    expect(isValidHost('app.bytescon.com')).toBe(true)
    expect(isValidHost('portal.acmefederal.com')).toBe(true)
    expect(isValidHost('sub.deep.nested.example.com')).toBe(true)
  })

  it('accepts localhost (dev escape hatch)', () => {
    expect(isValidHost('localhost')).toBe(true)
  })

  it('strips port from validation', () => {
    expect(isValidHost('bytescon.com:3000')).toBe(true)
    expect(isValidHost('localhost:3000')).toBe(true)
  })

  it('rejects malformed hosts', () => {
    expect(isValidHost('')).toBe(false)
    expect(isValidHost('not-a-host')).toBe(false) // no TLD
    expect(isValidHost('.com')).toBe(false)
    expect(isValidHost('acme..com')).toBe(false) // double dot
  })
})

describe('buildPortalUrl', () => {
  it('uses custom domain when verified', () => {
    expect(buildPortalUrl({
      customDomain: 'portal.acmefederal.com',
      customDomainVerifiedAt: new Date(),
    })).toBe('https://portal.acmefederal.com/client-portal')
  })

  it('ignores custom domain when not verified', () => {
    expect(buildPortalUrl({
      customDomain: 'portal.acmefederal.com',
      customDomainVerifiedAt: null,
      subdomain: 'acme',
    })).toBe(`https://acme.${PLATFORM_ROOT_DOMAIN}/client-portal`)
  })

  it('falls back to subdomain', () => {
    expect(buildPortalUrl({ subdomain: 'bytescon' }))
      .toBe(`https://bytescon.${PLATFORM_ROOT_DOMAIN}/client-portal`)
  })

  it('falls back to platform root', () => {
    expect(buildPortalUrl({}))
      .toBe(`https://${PLATFORM_ROOT_DOMAIN}/client-portal`)
  })

  it('respects custom path', () => {
    expect(buildPortalUrl({ subdomain: 'acme', path: '/billing' }))
      .toBe(`https://acme.${PLATFORM_ROOT_DOMAIN}/billing`)
  })
})
