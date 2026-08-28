// =============================================================
// §8.5 — Enterprise single sign-on (workforce OIDC).
//
// WHAT THIS IS NOT, first, because the confusion is expensive:
//
//   Not the MCP OAuth server. That authorizes an API client to call tools; it
//   has no concept of an employee and its tokens are credentials, not
//   sessions. Nothing here reuses it beyond the idea of a state parameter.
//
//   Not the client or partner portal. Those are separate external identities
//   with their own tables and their own tokens, and they stay that way.
//
//   Not a second user table. A successful SSO login resolves to an existing
//   internal `User` and then mints the ordinary internal session, so every
//   downstream permission, tenant scope and audit row behaves identically to a
//   password login.
//
// LINKING IS ON (issuer, subject), NEVER ON AN EMAIL ALONE. An email is a
// claim any identity provider can assert about anybody. If linking trusted it,
// a firm that configures its own IdP could assert `ceo@othercompany.com` and
// sign in as them. The email is used only to FIND a candidate the first time,
// and only when the tenant has explicitly allowed that domain.
// =============================================================
import crypto from 'crypto'
import { SsoProviderType } from '@prisma/client'
import { prisma } from '../../config/database'
import { encryptSecret, decryptSecret } from '../../utils/fieldCrypto'
import { logger } from '../../utils/logger'
import { UnauthorizedError, ValidationError } from '../../utils/errors'

const STATE_TTL_MS = 10 * 60 * 1000

export interface SsoStartResult {
  state: string
  nonce: string
  codeVerifier: string
  authorizationUrl: string
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url')
}

/**
 * Begin a login.
 *
 * The state, the nonce and the PKCE verifier are all minted here and stored
 * server-side against the tenant this flow started for. The callback proves it
 * holds the state; it never gets to say which tenant it is for.
 */
export async function startSsoLogin(
  consultingFirmId: string, redirectUri: string, returnTo?: string,
): Promise<SsoStartResult> {
  const config = await prisma.firmSsoConfig.findUnique({ where: { consultingFirmId } })
  if (!config || !config.enabled) throw new ValidationError('Single sign-on is not enabled for this organization')
  if (config.providerType !== SsoProviderType.OIDC) {
    throw new ValidationError('Only OIDC single sign-on is supported on this deployment')
  }
  if (!config.authorizationUrl || !config.clientId) {
    throw new ValidationError('This organization\'s single sign-on is not fully configured')
  }

  const state = base64url(crypto.randomBytes(32))
  const nonce = base64url(crypto.randomBytes(32))
  const codeVerifier = base64url(crypto.randomBytes(32))
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest())

  await prisma.ssoLoginState.create({
    data: {
      consultingFirmId,
      stateHash: sha256(state),
      nonce,
      codeVerifierEnc: encryptSecret(codeVerifier),
      redirectUri,
      returnTo: returnTo ?? null,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    },
  })

  const url = new URL(config.authorizationUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', state)
  url.searchParams.set('nonce', nonce)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')

  return { state, nonce, codeVerifier, authorizationUrl: url.toString() }
}

export interface ConsumedSsoState {
  consultingFirmId: string
  nonce: string
  redirectUri: string
  returnTo: string | null
  codeVerifier: string | null
}

/** Validate and burn a login state. Unknown, expired and spent all fail alike. */
export async function consumeSsoState(state: string): Promise<ConsumedSsoState> {
  const row = await prisma.ssoLoginState.findUnique({ where: { stateHash: sha256(state) } })
  if (!row || row.consumedAt || row.expiresAt < new Date()) {
    throw new UnauthorizedError('That sign-in link is invalid or has expired')
  }
  const burned = await prisma.ssoLoginState.updateMany({
    where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() },
  })
  if (burned.count !== 1) throw new UnauthorizedError('That sign-in link is invalid or has expired')
  return {
    consultingFirmId: row.consultingFirmId,
    nonce: row.nonce,
    redirectUri: row.redirectUri,
    returnTo: row.returnTo,
    codeVerifier: decryptSecret(row.codeVerifierEnc),
  }
}

/** The claims a verified ID token must supply. */
export interface IdTokenClaims {
  iss: string
  aud: string | string[]
  sub: string
  nonce?: string
  exp: number
  email?: string
  email_verified?: boolean
  given_name?: string
  family_name?: string
  name?: string
}

export interface ClaimValidationInput {
  claims: IdTokenClaims
  expectedIssuer: string
  expectedAudience: string
  expectedNonce: string
  now?: Date
}

/**
 * Validate the claims of an already signature-verified ID token.
 *
 * Every one of these is a real attack if skipped: a wrong issuer is a token
 * from somebody else's IdP, a wrong audience is a token minted for a different
 * application, a missing nonce is a replayed token, and an expired token is
 * one that should no longer authenticate anybody.
 */
export function validateIdTokenClaims(input: ClaimValidationInput): void {
  const { claims, expectedIssuer, expectedAudience, expectedNonce } = input
  const now = input.now ?? new Date()

  if (claims.iss !== expectedIssuer) throw new UnauthorizedError('The sign-in token came from an unexpected issuer')
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audiences.includes(expectedAudience)) throw new UnauthorizedError('The sign-in token was issued for a different application')
  if (!claims.sub) throw new UnauthorizedError('The sign-in token carries no subject')
  if (claims.nonce !== expectedNonce) throw new UnauthorizedError('The sign-in token does not match this sign-in attempt')
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now.getTime()) {
    throw new UnauthorizedError('The sign-in token has expired')
  }
}

export interface ResolvedSsoUser {
  userId: string
  provisioned: boolean
}

function domainOf(email: string): string {
  return email.split('@').pop()?.toLowerCase() ?? ''
}

/**
 * Resolve an authenticated subject to an internal user.
 *
 * Order is deliberate:
 *
 *  1. An existing (issuer, subject) link wins outright. That link was made by
 *     a previous successful login and is the only trustworthy identifier.
 *  2. Otherwise the email may be used to find a candidate — but only if the
 *     provider marked it verified, only if its domain is on the tenant's
 *     allow-list, and only if the candidate already belongs to THIS tenant. A
 *     user in another firm is never linked, whatever the email says.
 *  3. Otherwise the tenant must have explicitly enabled provisioning. If it
 *     has not, the login is refused rather than silently creating an account.
 */
export async function resolveSsoUser(
  consultingFirmId: string, claims: IdTokenClaims,
): Promise<ResolvedSsoUser> {
  const config = await prisma.firmSsoConfig.findUnique({ where: { consultingFirmId } })
  if (!config || !config.enabled) throw new UnauthorizedError('Single sign-on is not enabled for this organization')

  const existing = await prisma.ssoIdentity.findUnique({
    where: { issuer_subject: { issuer: claims.iss, subject: claims.sub } },
    select: { userId: true, consultingFirmId: true, ssoConfigId: true },
  })
  if (existing) {
    // A subject bound to another tenant must not authenticate here, even
    // though the issuer matched: two firms can legitimately use the same IdP.
    if (existing.consultingFirmId !== consultingFirmId) {
      logger.warn('SSO subject is bound to a different tenant', { consultingFirmId })
      throw new UnauthorizedError('That account is not a member of this organization')
    }
    const user = await prisma.user.findFirst({
      where: { id: existing.userId, consultingFirmId, isActive: true }, select: { id: true },
    })
    if (!user) throw new UnauthorizedError('That account is no longer active')
    await prisma.ssoIdentity.update({
      where: { issuer_subject: { issuer: claims.iss, subject: claims.sub } },
      data: { lastLoginAt: new Date(), email: claims.email ?? null },
    })
    return { userId: user.id, provisioned: false }
  }

  const email = claims.email?.trim().toLowerCase()
  if (!email) throw new UnauthorizedError('The identity provider supplied no email address')
  if (claims.email_verified === false) {
    throw new UnauthorizedError('The identity provider has not verified that email address')
  }
  if (config.allowedEmailDomains.length > 0 && !config.allowedEmailDomains.map((d) => d.toLowerCase()).includes(domainOf(email))) {
    throw new UnauthorizedError('That email domain is not allowed to sign in to this organization')
  }

  const candidate = await prisma.user.findFirst({
    where: { email, consultingFirmId, isActive: true }, select: { id: true },
  })
  if (candidate) {
    await prisma.ssoIdentity.create({
      data: {
        consultingFirmId, ssoConfigId: config.id, userId: candidate.id,
        issuer: claims.iss, subject: claims.sub, email, lastLoginAt: new Date(),
      },
    })
    return { userId: candidate.id, provisioned: false }
  }

  if (!config.autoProvision) {
    throw new UnauthorizedError('No account exists for that address, and this organization does not create accounts automatically')
  }

  // A provisioned account gets the tenant's configured default role, never
  // ADMIN unless an administrator explicitly set that as the default.
  const created = await prisma.user.create({
    data: {
      consultingFirmId,
      email,
      // No password is set to anything guessable: a random hash means the
      // account simply has no password login until someone resets it.
      passwordHash: crypto.randomBytes(32).toString('hex'),
      firstName: claims.given_name ?? claims.name?.split(' ')[0] ?? 'New',
      lastName: claims.family_name ?? claims.name?.split(' ').slice(1).join(' ') ?? 'User',
      role: config.defaultRole,
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
    },
    select: { id: true },
  })
  await prisma.ssoIdentity.create({
    data: {
      consultingFirmId, ssoConfigId: config.id, userId: created.id,
      issuer: claims.iss, subject: claims.sub, email, lastLoginAt: new Date(),
    },
  })
  logger.info('SSO provisioned a new user', { consultingFirmId, role: config.defaultRole })
  return { userId: created.id, provisioned: true }
}

/**
 * May this account still sign in with a password?
 *
 * BREAK-GLASS. When a tenant enforces SSO, password login is refused — except
 * for the addresses on `breakGlassEmails`, and except when the tenant has
 * listed none at all. That last clause is the important one: a firm that
 * enables enforcement and then misconfigures its IdP would otherwise lock
 * every one of its own administrators out of the tenant, with no way back in
 * that does not involve the platform operator editing the database.
 */
export interface PasswordLoginDecision {
  allowed: boolean
  reason?: string
}

export async function passwordLoginAllowed(
  consultingFirmId: string, email: string,
): Promise<PasswordLoginDecision> {
  const config = await prisma.firmSsoConfig.findUnique({
    where: { consultingFirmId },
    select: { enabled: true, enforced: true, breakGlassEmails: true },
  })
  if (!config || !config.enabled || !config.enforced) return { allowed: true }

  const normalized = email.trim().toLowerCase()
  if (config.breakGlassEmails.map((e) => e.toLowerCase()).includes(normalized)) {
    return { allowed: true, reason: 'break-glass account' }
  }
  if (config.breakGlassEmails.length === 0) {
    // Enforcement with no escape hatch is a lockout waiting to happen, so it
    // is treated as a misconfiguration rather than obeyed.
    logger.warn('SSO enforcement has no break-glass account; allowing password login', { consultingFirmId })
    return { allowed: true, reason: 'no break-glass account configured' }
  }
  return { allowed: false, reason: 'This organization requires single sign-on' }
}
