// =============================================================
// §8.5 — Enterprise SSO routes.
//
// Two audiences on one router:
//
//   Administration (SSO_MANAGE) — configure the tenant's identity provider.
//   The client secret is written but never read back; the response says
//   whether one is stored, not what it is.
//
//   Login (public) — discovery by email domain, start, and callback. The
//   callback trusts nothing in its own query string except a state this
//   server minted, and mints the ORDINARY internal session on success, so a
//   user who signed in with SSO is indistinguishable downstream from one who
//   typed a password.
// =============================================================
import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import jwt from 'jsonwebtoken'
import { SsoProviderType } from '@prisma/client'
import { prisma } from '../config/database'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT, buildJwtPayload, generateToken, setSessionCookie } from '../middleware/auth'
import { requirePermission } from '../middleware/permissions'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { encryptSecret } from '../utils/fieldCrypto'
import { logger } from '../utils/logger'
import { ValidationError, UnauthorizedError } from '../utils/errors'
import { logAudit } from '../services/auditService'
import { isRole } from '../services/rbac/permissions'
import {
  consumeSsoState, resolveSsoUser, startSsoLogin, validateIdTokenClaims, type IdTokenClaims,
} from '../services/sso/ssoService'

const router = Router()

/** The unauthenticated half. Mounted separately so no session is implied. */
export const ssoPublicRouter = Router()

// -------------------------------------------------------------
// Administration
// -------------------------------------------------------------

const admin = Router()
admin.use(authenticateJWT, enforceTenantScope)

const ConfigSchema = z.object({
  providerType: z.nativeEnum(SsoProviderType).optional(),
  displayName: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  issuer: z.string().trim().url().max(500).nullable().optional(),
  clientId: z.string().trim().max(300).nullable().optional(),
  clientSecret: z.string().trim().min(8).max(500).nullable().optional(),
  authorizationUrl: z.string().trim().url().max(500).nullable().optional(),
  tokenUrl: z.string().trim().url().max(500).nullable().optional(),
  jwksUri: z.string().trim().url().max(500).nullable().optional(),
  allowedEmailDomains: z.array(z.string().trim().min(3).max(200)).max(50).optional(),
  enforced: z.boolean().optional(),
  breakGlassEmails: z.array(z.string().trim().email().max(200)).max(20).optional(),
  autoProvision: z.boolean().optional(),
  defaultRole: z.string().trim().max(40).optional(),
}).strict()

/** What an administrator may read back. The secret is a boolean here, always. */
function toConfigDto(row: {
  id: string; providerType: SsoProviderType; displayName: string; enabled: boolean
  issuer: string | null; clientId: string | null; clientSecretEnc: string | null
  authorizationUrl: string | null; tokenUrl: string | null; jwksUri: string | null
  allowedEmailDomains: string[]; enforced: boolean; breakGlassEmails: string[]
  autoProvision: boolean; defaultRole: string; lastLoginAt: Date | null; lastError: string | null
}) {
  return {
    id: row.id, providerType: row.providerType, displayName: row.displayName, enabled: row.enabled,
    issuer: row.issuer, clientId: row.clientId,
    clientSecretConfigured: Boolean(row.clientSecretEnc),
    authorizationUrl: row.authorizationUrl, tokenUrl: row.tokenUrl, jwksUri: row.jwksUri,
    allowedEmailDomains: row.allowedEmailDomains, enforced: row.enforced,
    breakGlassEmails: row.breakGlassEmails, autoProvision: row.autoProvision,
    defaultRole: row.defaultRole,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null, lastError: row.lastError,
  }
}

admin.get('/config', requirePermission('SSO_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const row = await prisma.firmSsoConfig.findUnique({ where: { consultingFirmId } })
    res.json({ success: true, data: row ? toConfigDto(row) : null })
  } catch (err) { next(err) }
})

admin.put('/config', requirePermission('SSO_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = ConfigSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid SSO configuration')
    const d = parsed.data

    if (d.defaultRole !== undefined) {
      if (!isRole(d.defaultRole)) throw new ValidationError('That is not a valid role')
      // A default role is applied without review to whoever the IdP sends, so
      // it must not be the one that can do everything.
      if (d.defaultRole === 'ADMIN') {
        throw new ValidationError('ADMIN cannot be the automatic provisioning role. Promote a user deliberately instead.')
      }
    }
    if (d.enabled && d.providerType !== SsoProviderType.SAML) {
      const existing = await prisma.firmSsoConfig.findUnique({ where: { consultingFirmId } })
      const issuer = d.issuer ?? existing?.issuer
      const clientId = d.clientId ?? existing?.clientId
      const authorizationUrl = d.authorizationUrl ?? existing?.authorizationUrl
      if (!issuer || !clientId || !authorizationUrl) {
        throw new ValidationError('Single sign-on needs an issuer, a client id and an authorization URL before it can be enabled')
      }
    }

    const { clientSecret, ...rest } = d
    const data = {
      ...rest,
      ...(clientSecret !== undefined
        ? { clientSecretEnc: clientSecret === null ? null : encryptSecret(clientSecret) }
        : {}),
      updatedByUserId: req.user?.userId ?? null,
    }
    const row = await prisma.firmSsoConfig.upsert({
      where: { consultingFirmId },
      create: { consultingFirmId, ...data },
      update: data,
    })
    await logAudit({
      consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role,
      actorKind: 'INTERNAL_USER', action: 'UPDATE', entityType: 'FirmSsoConfig', entityId: row.id,
      // Names the fields that changed, never their values.
      rationale: `Single sign-on configuration updated (${Object.keys(d).join(', ')})`,
    })
    res.json({ success: true, data: toConfigDto(row) })
  } catch (err) { next(err) }
})

admin.get('/identities', requirePermission('SSO_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const rows = await prisma.ssoIdentity.findMany({
      where: { consultingFirmId },
      select: {
        id: true, issuer: true, email: true, lastLoginAt: true, createdAt: true,
        user: { select: { id: true, email: true, firstName: true, lastName: true, role: true, isActive: true } },
      },
      orderBy: { createdAt: 'desc' }, take: 200,
    })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})

router.use('/admin', admin)

// -------------------------------------------------------------
// Login
// -------------------------------------------------------------

function callbackUrl(): string {
  const base = process.env.PUBLIC_API_URL || 'http://localhost:3001'
  return `${base}/api/sso/callback`
}

/**
 * Which organization does this address sign in to?
 *
 * Returns only whether SSO is available and what to call the button. It never
 * reveals whether the address has an account, so it cannot be used to
 * enumerate users.
 */
ssoPublicRouter.get('/discover', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : ''
    const domain = email.split('@').pop() ?? ''
    if (!domain || domain.length < 3) {
      res.json({ success: true, data: { available: false } })
      return
    }
    const config = await prisma.firmSsoConfig.findFirst({
      where: { enabled: true, allowedEmailDomains: { has: domain } },
      select: { consultingFirmId: true, displayName: true },
    })
    res.json({
      success: true,
      data: config
        ? { available: true, consultingFirmId: config.consultingFirmId, displayName: config.displayName }
        : { available: false },
    })
  } catch (err) { next(err) }
})

ssoPublicRouter.post('/start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = z.object({
      consultingFirmId: z.string().min(1),
      returnTo: z.string().trim().max(300).optional(),
    }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('An organization is required')

    // The caller names which tenant's IdP to start with — which is safe,
    // because the tenant is then pinned into the state row and the callback
    // reads it from there, not from the caller.
    const result = await startSsoLogin(parsed.data.consultingFirmId, callbackUrl(), parsed.data.returnTo)
    res.json({ success: true, data: { authorizationUrl: result.authorizationUrl } })
  } catch (err) { next(err) }
})

/**
 * Decode an ID token WITHOUT verifying its signature.
 *
 * Signature verification needs the IdP's JWKS, which this deployment cannot
 * fetch because no identity provider is configured. Rather than pretend, the
 * callback refuses unless a verification key is configured — see below. This
 * helper exists only to read claims from a token whose signature has already
 * been checked.
 */
function decodeClaims(idToken: string): IdTokenClaims {
  const decoded = jwt.decode(idToken) as IdTokenClaims | null
  if (!decoded || typeof decoded !== 'object') throw new UnauthorizedError('The identity provider returned an unreadable token')
  return decoded
}

ssoPublicRouter.get('/callback', async (req: Request, res: Response) => {
  const appUrl = process.env.PUBLIC_APP_URL || 'http://localhost:5173'
  try {
    const code = typeof req.query.code === 'string' ? req.query.code : null
    const state = typeof req.query.state === 'string' ? req.query.state : null
    if (!code || !state) throw new UnauthorizedError('The identity provider returned an incomplete response')

    const consumed = await consumeSsoState(state)
    const config = await prisma.firmSsoConfig.findUnique({ where: { consultingFirmId: consumed.consultingFirmId } })
    if (!config || !config.enabled || !config.tokenUrl || !config.issuer || !config.clientId) {
      throw new UnauthorizedError('Single sign-on is not configured for this organization')
    }

    const { providerRequest } = await import('../services/integrations/httpClient')
    const { decryptSecret } = await import('../utils/fieldCrypto')
    const tokenResponse = await providerRequest<{ id_token?: string }>('sso.token', {
      method: 'POST',
      url: config.tokenUrl,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: consumed.redirectUri,
        client_id: config.clientId,
        ...(config.clientSecretEnc ? { client_secret: decryptSecret(config.clientSecretEnc) ?? '' } : {}),
        ...(consumed.codeVerifier ? { code_verifier: consumed.codeVerifier } : {}),
      }).toString(),
    })
    if (!tokenResponse.id_token) throw new UnauthorizedError('The identity provider returned no identity token')

    const { verifyIdTokenSignature } = await import('../services/sso/idTokenVerifier')
    await verifyIdTokenSignature(tokenResponse.id_token, config)

    const claims = decodeClaims(tokenResponse.id_token)
    validateIdTokenClaims({
      claims,
      expectedIssuer: config.issuer,
      expectedAudience: config.clientId,
      expectedNonce: consumed.nonce,
    })

    const resolved = await resolveSsoUser(consumed.consultingFirmId, claims)
    const user = await prisma.user.findUnique({
      where: { id: resolved.userId }, include: { consultingFirm: { select: { id: true, name: true, isActive: true } } },
    })
    if (!user || !user.isActive || !user.consultingFirm.isActive) {
      throw new UnauthorizedError('That account is not active')
    }

    // The ORDINARY internal session. Nothing downstream can tell how it was
    // obtained, which is the point.
    const token = generateToken(buildJwtPayload({
      userId: user.id, consultingFirmId: user.consultingFirmId, role: user.role, email: user.email,
    }))
    setSessionCookie(res, token)
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
    await prisma.firmSsoConfig.update({
      where: { consultingFirmId: consumed.consultingFirmId },
      data: { lastLoginAt: new Date(), lastError: null },
    })
    await logAudit({
      consultingFirmId: user.consultingFirmId, actorUserId: user.id, actorRole: user.role,
      actorKind: 'INTERNAL_USER', action: 'LOGIN', entityType: 'User', entityId: user.id,
      rationale: resolved.provisioned ? 'Signed in with SSO (account provisioned)' : 'Signed in with SSO',
    })

    const target = consumed.returnTo && consumed.returnTo.startsWith('/') ? consumed.returnTo : '/dashboard'
    res.redirect(`${appUrl}${target}`)
  } catch (err) {
    logger.warn('SSO callback failed', { error: (err as Error).message })
    res.redirect(`${appUrl}/login?sso=failed`)
  }
})

export default router
