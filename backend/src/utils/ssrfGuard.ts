// =============================================================
// SSRF guard for firm-configurable outbound URLs.
//
// A tenant ADMIN can set the firm's LocalAI/Ollama base URL. Without a
// guard, that admin could point the server at internal-only hosts (cloud
// instance metadata at 169.254.169.254, internal services, loopback) and
// turn an LLM call into a server-side request forgery. This module rejects
// base URLs that target private / loopback / link-local / reserved ranges.
//
// The bundled self-hosted Ollama runs at an internal hostname ("ollama"),
// which is a legitimate target, so allowlisted hosts (LLM_HOST_ALLOWLIST,
// default "ollama,localhost") bypass the IP check. Operators running fully
// self-hosted / single-tenant — where reaching internal hosts is expected —
// can disable the guard entirely with LLM_ALLOW_PRIVATE_BASE_URL=1.
// =============================================================
import { promises as dns } from 'dns'
import net from 'net'
import { ValidationError } from './errors'

function envAllowlist(): Set<string> {
  const raw = process.env.LLM_HOST_ALLOWLIST ?? 'ollama,localhost'
  return new Set(
    raw
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  )
}

function guardDisabled(): boolean {
  return process.env.LLM_ALLOW_PRIVATE_BASE_URL === '1'
}

function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true // malformed → unsafe
  const [a, b] = p
  if (a === 0) return true // 0.0.0.0/8 "this network"
  if (a === 10) return true // 10/8 private
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local — incl. 169.254.169.254 cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12 private
  if (a === 192 && b === 168) return true // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT
  if (a >= 224) return true // 224/4 multicast + 240/4 reserved
  return false
}

function isPrivateV6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0] // strip zone id
  if (addr === '::1' || addr === '::') return true // loopback / unspecified
  // IPv4-mapped (::ffff:a.b.c.d) or -compatible (::a.b.c.d) — check the embedded v4
  const mapped = addr.match(/(?:::ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (mapped) return isPrivateV4(mapped[1])
  const head = addr.split(':')[0]
  if (head.startsWith('fc') || head.startsWith('fd')) return true // fc00::/7 unique-local
  if (head.startsWith('fe8') || head.startsWith('fe9') || head.startsWith('fea') || head.startsWith('feb')) return true // fe80::/10 link-local
  return false
}

/** True for IP literals that must never be reachable via a user-supplied URL. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const v = net.isIP(ip)
  if (v === 4) return isPrivateV4(ip)
  if (v === 6) return isPrivateV6(ip)
  return false
}

function parseHttpUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ValidationError('LocalAI base URL is not a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError('LocalAI base URL must use http or https')
  }
  if (url.username || url.password) {
    throw new ValidationError('LocalAI base URL must not contain embedded credentials')
  }
  return url
}

/**
 * Full validation for the write path (admin saves config). Resolves DNS so a
 * public-looking hostname that points at an internal address is also rejected.
 * Returns the normalized URL string; throws ValidationError on anything unsafe.
 */
export async function assertSafeLlmBaseUrl(raw: string): Promise<string> {
  const url = parseHttpUrl(raw)
  if (guardDisabled()) return url.toString()

  const host = url.hostname.toLowerCase()
  if (envAllowlist().has(host)) return url.toString()

  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new ValidationError('LocalAI base URL may not target a private or reserved IP address')
    }
    return url.toString()
  }

  let addrs: Array<{ address: string }>
  try {
    addrs = await dns.lookup(host, { all: true })
  } catch {
    throw new ValidationError('LocalAI base URL host could not be resolved')
  }
  if (addrs.some((a) => isPrivateOrReservedIp(a.address))) {
    throw new ValidationError('LocalAI base URL resolves to a private or reserved address')
  }
  return url.toString()
}

/**
 * Cheap synchronous defense-in-depth for the use path (no DNS). Blocks stored
 * values that target a literal private/reserved IP or a non-http(s) scheme.
 * Returns true when the URL should be rejected/ignored.
 */
export function isLlmBaseUrlBlockedSync(raw: string): boolean {
  if (guardDisabled()) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return true
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true
  const host = url.hostname.toLowerCase()
  if (envAllowlist().has(host)) return false
  if (net.isIP(host)) return isPrivateOrReservedIp(host)
  return false // hostnames pass the sync gate; the write-path DNS check is the primary control
}
