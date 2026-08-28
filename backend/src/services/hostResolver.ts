// =============================================================
// Host Resolver — Maps incoming Host header to a ConsultingFirm
//
// Resolution order:
//   1. customDomain exact match (e.g., portal.acmefederal.com)
//   2. subdomain match against PLATFORM_ROOT (e.g., acme.bytescon.com)
//   3. apex/app/portal -> default platform host (no firm scope)
//
// Tenancy: this service does not authenticate; it only identifies which
// firm's branding/portal a request should render. Auth still happens via
// JWT downstream.
//
// Compliance: rejects malformed hosts, never trusts arbitrary input,
// caches resolutions in-memory with TTL to limit DB load.
// =============================================================

import { prisma } from '../config/database'
import { logger } from '../utils/logger'

const PLATFORM_ROOT = process.env.PLATFORM_ROOT_DOMAIN || 'bytescon.com'
const RESERVED_SUBDOMAINS = new Set([
  'www', 'app', 'portal', 'api', 'admin', 'docs', 'help',
  'status', 'mail', 'ftp', 'cdn', 'assets', 'static',
  'support', 'blog', 'public', 'localhost',
])

// -------------------------------------------------------------
// Validation
// -------------------------------------------------------------

const SUBDOMAIN_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const HOST_REGEX = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i

export function isValidSubdomain(s: string): boolean {
  if (!s) return false
  // Reject any uppercase before lowercasing — caller must submit
  // canonical lowercase form (matches DNS RFC 1035 + our DB unique index)
  if (s !== s.toLowerCase()) return false
  if (RESERVED_SUBDOMAINS.has(s)) return false
  if (s.length < 2 || s.length > 63) return false
  return SUBDOMAIN_REGEX.test(s)
}

export function isValidHost(host: string): boolean {
  if (!host) return false
  const stripped = host.split(':')[0].toLowerCase()
  if (stripped === 'localhost') return true
  return HOST_REGEX.test(stripped)
}

// -------------------------------------------------------------
// In-memory cache (5-minute TTL)
// Keeps DB lookups off the request hot path; small N (one entry per
// distinct host seen). Invalidated explicitly on subdomain/customDomain
// updates via clearHostCache.
// -------------------------------------------------------------

interface CacheEntry {
  firmId: string | null
  expires: number
}
const hostCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 5 * 60 * 1000

export function clearHostCache(host?: string): void {
  if (host) {
    hostCache.delete(host.toLowerCase())
  } else {
    hostCache.clear()
  }
}

// -------------------------------------------------------------
// Public API: resolve host -> firmId | null
// -------------------------------------------------------------

export async function resolveHostToFirmId(rawHost: string | undefined): Promise<string | null> {
  if (!rawHost) return null
  const host = rawHost.split(':')[0].toLowerCase().trim()

  if (!isValidHost(host)) {
    logger.warn('Host resolver rejected invalid host', { host })
    return null
  }

  // Cache hit
  const cached = hostCache.get(host)
  if (cached && cached.expires > Date.now()) {
    return cached.firmId
  }

  let firmId: string | null = null

  // 1. Custom domain exact match
  const byCustom = await prisma.consultingFirm.findUnique({
    where: { customDomain: host },
    select: { id: true, customDomainVerifiedAt: true },
  }).catch(() => null)
  if (byCustom?.customDomainVerifiedAt) {
    firmId = byCustom.id
  }

  // 2. Subdomain of PLATFORM_ROOT
  if (!firmId && host.endsWith(`.${PLATFORM_ROOT}`)) {
    const sub = host.slice(0, host.length - PLATFORM_ROOT.length - 1)
    // Require single-label subdomain (no nested like a.b.bytescon.com)
    if (sub && !sub.includes('.') && !RESERVED_SUBDOMAINS.has(sub)) {
      const bySubdomain = await prisma.consultingFirm.findUnique({
        where: { subdomain: sub },
        select: { id: true },
      }).catch(() => null)
      if (bySubdomain) {
        firmId = bySubdomain.id
      }
    }
  }

  hostCache.set(host, { firmId, expires: Date.now() + CACHE_TTL_MS })
  return firmId
}

// -------------------------------------------------------------
// Get all custom domains (for CORS allowlist generation)
// Cached separately, refreshed every 5 minutes
// -------------------------------------------------------------

let customDomainsCache: { domains: string[]; expires: number } | null = null

export async function getVerifiedCustomDomains(): Promise<string[]> {
  if (customDomainsCache && customDomainsCache.expires > Date.now()) {
    return customDomainsCache.domains
  }

  const firms = await prisma.consultingFirm.findMany({
    where: {
      customDomain: { not: null },
      customDomainVerifiedAt: { not: null },
    },
    select: { customDomain: true },
  }).catch(() => [])

  const domains = firms.map(f => f.customDomain!).filter(Boolean)
  customDomainsCache = { domains, expires: Date.now() + CACHE_TTL_MS }
  return domains
}

export function clearCustomDomainsCache(): void {
  customDomainsCache = null
}

// -------------------------------------------------------------
// Build the canonical portal URL for a firm (used in emails, etc.)
// -------------------------------------------------------------

export function buildPortalUrl(opts: {
  customDomain?: string | null
  customDomainVerifiedAt?: Date | null
  subdomain?: string | null
  path?: string
}): string {
  const path = opts.path || '/client-portal'
  if (opts.customDomain && opts.customDomainVerifiedAt) {
    return `https://${opts.customDomain}${path}`
  }
  if (opts.subdomain) {
    return `https://${opts.subdomain}.${PLATFORM_ROOT}${path}`
  }
  return `https://${PLATFORM_ROOT}${path}`
}

export const PLATFORM_ROOT_DOMAIN = PLATFORM_ROOT
