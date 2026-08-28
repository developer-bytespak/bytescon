// =============================================================
// §8.5 — ID token signature verification.
//
// THE HONEST PART OF THE SSO STORY.
//
// An ID token's claims mean nothing until its signature is verified against
// the identity provider's key. This deployment has no identity provider
// configured and cannot reach a JWKS endpoint, so rather than decode a token
// and treat its claims as authenticated — which is exactly the vulnerability
// an SSO integration exists to avoid — verification is REQUIRED and fails
// closed when no key is available.
//
// Two verification paths are supported:
//
//   A shared HMAC secret (HS256), for identity providers configured with one
//   and for the deterministic tests. Symmetric, so the client secret is the
//   verification key.
//
//   A JWKS URI (RS256), fetched from the provider and cached briefly. This is
//   the path a production OIDC provider uses, and it is implemented — but it
//   has never been run against a live IdP on this deployment, and is reported
//   as credential-gated rather than verified.
// =============================================================
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { UnauthorizedError } from '../../utils/errors'
import { decryptSecret } from '../../utils/fieldCrypto'
import { providerRequest } from '../integrations/httpClient'

export interface VerifiableSsoConfig {
  issuer: string | null
  clientId: string | null
  clientSecretEnc: string | null
  jwksUri: string | null
}

interface Jwk {
  kid?: string
  kty?: string
  n?: string
  e?: string
  alg?: string
  use?: string
}

const JWKS_TTL_MS = 10 * 60 * 1000
const jwksCache = new Map<string, { fetchedAt: number; keys: Jwk[] }>()

/** Test seam. Production never calls this. */
export function __primeJwksCache(uri: string, keys: Jwk[]): void {
  jwksCache.set(uri, { fetchedAt: Date.now(), keys })
}

export function __clearJwksCache(): void {
  jwksCache.clear()
}

async function loadJwks(uri: string): Promise<Jwk[]> {
  const cached = jwksCache.get(uri)
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys
  const data = await providerRequest<{ keys?: Jwk[] }>('sso.jwks', { method: 'GET', url: uri })
  const keys = data.keys ?? []
  jwksCache.set(uri, { fetchedAt: Date.now(), keys })
  return keys
}

function jwkToPem(jwk: Jwk): string {
  if (!jwk.n || !jwk.e) throw new UnauthorizedError('The identity provider published an unusable signing key')
  const key = crypto.createPublicKey({
    key: { kty: 'RSA', n: jwk.n, e: jwk.e } as crypto.JsonWebKey,
    format: 'jwk',
  })
  return key.export({ type: 'spki', format: 'pem' }).toString()
}

/**
 * Verify the token's signature, or refuse.
 *
 * There is no path through this function that accepts an unverified token.
 */
export async function verifyIdTokenSignature(
  idToken: string, config: VerifiableSsoConfig,
): Promise<void> {
  const header = jwt.decode(idToken, { complete: true })?.header
  if (!header) throw new UnauthorizedError('The identity provider returned an unreadable token')

  if (header.alg === 'HS256') {
    const secret = decryptSecret(config.clientSecretEnc)
    if (!secret) throw new UnauthorizedError('No verification key is configured for this identity provider')
    try {
      jwt.verify(idToken, secret, { algorithms: ['HS256'] })
      return
    } catch {
      throw new UnauthorizedError('The identity token signature is not valid')
    }
  }

  if (header.alg === 'RS256') {
    if (!config.jwksUri) throw new UnauthorizedError('No verification key is configured for this identity provider')
    const keys = await loadJwks(config.jwksUri)
    const jwk = keys.find((k) => (header.kid ? k.kid === header.kid : true) && k.kty === 'RSA')
    if (!jwk) throw new UnauthorizedError('The identity provider published no matching signing key')
    try {
      jwt.verify(idToken, jwkToPem(jwk), { algorithms: ['RS256'] })
      return
    } catch {
      throw new UnauthorizedError('The identity token signature is not valid')
    }
  }

  // `none`, and anything else, is refused rather than handled.
  throw new UnauthorizedError('The identity token uses an unsupported signature algorithm')
}
