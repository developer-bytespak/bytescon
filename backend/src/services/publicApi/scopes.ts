// =============================================================
// §8.4 — Public API v1 scopes.
//
// v1 is READ-ONLY on purpose. Every write in this platform that matters sits
// behind a human gate — bid/no-bid, proposal approval, submission, budget,
// purchase-order and invoice approval, payment, legal flow-down review, portal
// access grants, resume approval — and a scope that could be granted to an
// integration is exactly the wrong place to put one of those. There is
// therefore no write scope to grant, rather than a write scope nobody uses.
//
// Scopes are NOT roles. An internal ADMIN's permissions have no bearing here:
// a token carries the scopes it was minted with and nothing more.
// =============================================================

export const PUBLIC_API_SCOPES = [
  'opportunities:read',
  'pursuits:read',
  'contracts:read',
  'crm:read',
  'partners:read',
  'personnel:read',
  'analytics:read',
] as const

export type PublicApiScope = (typeof PUBLIC_API_SCOPES)[number]

export const PUBLIC_API_SCOPE_DESCRIPTIONS: Record<PublicApiScope, string> = {
  'opportunities:read': 'Read opportunities the firm has ingested.',
  'pursuits:read': 'Read the pursuit pipeline (stage, priority, close state).',
  'contracts:read': 'Read awarded contracts and their period of performance.',
  'crm:read': 'Read government and partner contact records.',
  'partners:read': 'Read the partner/teaming directory.',
  'personnel:read': 'Read the personnel directory and resume approval state.',
  'analytics:read': 'Read aggregate portfolio counts and totals.',
}

export function isPublicApiScope(value: unknown): value is PublicApiScope {
  return typeof value === 'string' && (PUBLIC_API_SCOPES as readonly string[]).includes(value)
}

/** Keep only recognized scopes. An unknown string grants nothing, silently or otherwise. */
export function normalizeScopes(input: unknown): PublicApiScope[] {
  if (!Array.isArray(input)) return []
  const out = new Set<PublicApiScope>()
  for (const value of input) if (isPublicApiScope(value)) out.add(value)
  return [...out]
}
