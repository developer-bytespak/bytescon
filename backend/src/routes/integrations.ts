// =============================================================
// §8.5 — Integration administration.
//
// One internal surface for every external provider. Every route needs
// INTEGRATION_MANAGE, which ADMIN holds and no granular role does.
//
// NOTHING HERE RETURNS A CREDENTIAL. Responses are built by
// `toConnectionDto`, which has no field that could carry one, and the OAuth
// callback redirects rather than rendering a token.
// =============================================================
import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { IntegrationProvider, IntegrationStatus } from '@prisma/client'
import { prisma } from '../config/database'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT } from '../middleware/auth'
import { requirePermission } from '../middleware/permissions'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { ValidationError, NotFoundError } from '../utils/errors'
import { logAudit } from '../services/auditService'
import { logger } from '../utils/logger'
import {
  ALL_PROVIDERS, PROVIDER_DEFINITIONS, missingEnv, platformConfigured,
} from '../services/integrations/registry'
import {
  disconnectConnection, findConnection, listConnections, readCredential, requireConnection,
  startOAuthState, consumeOAuthState, toConnectionDto, unconnectedDto, upsertConnection,
} from '../services/integrations/connectionService'
import { connectorFor, exportDocument, reconcilePayments, buildInvoicePayload, buildSubcontractInvoicePayload } from '../services/integrations/accounting/syncService'
import { calendarAdapterFor, syncFirmMilestones } from '../services/integrations/calendar/calendarSync'
import { exchangeGoogleCode, GOOGLE_AUTH_URL, GOOGLE_SCOPES } from '../services/integrations/calendar/google'
import { exchangeMicrosoftCode, MICROSOFT_AUTH_URL, MICROSOFT_SCOPES } from '../services/integrations/calendar/microsoft'
import { exchangeSlackCode, SLACK_AUTH_URL, SLACK_SCOPES } from '../services/integrations/channels/slack'
import { isAllowedTeamsWebhook } from '../services/integrations/channels/teams'
import { QUICKBOOKS_AUTH_URL, QUICKBOOKS_SCOPES } from '../services/integrations/accounting/quickbooks'
import { exchangeDocusignCode, DOCUSIGN_AUTH_URL, DOCUSIGN_SCOPES } from '../services/integrations/esign/docusign'
import { ConnectorError } from '../services/integrations/accounting/connector'

const router = Router()

/** Callbacks arrive from a browser redirect and carry no session. */
export const callbackRouter = Router()

router.use(authenticateJWT, enforceTenantScope, requireActiveBase)

const audit = (
  req: AuthenticatedRequest, consultingFirmId: string, action: 'CREATE' | 'UPDATE' | 'DELETE',
  entityId: string, rationale: string,
) => logAudit({
  consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role,
  actorKind: 'INTERNAL_USER', action, entityType: 'IntegrationConnection', entityId,
  // The rationale names the provider and the act, never a credential.
  rationale,
})

function providerParam(value: string): IntegrationProvider {
  if (!(value in PROVIDER_DEFINITIONS)) throw new ValidationError('Unknown provider')
  return value as IntegrationProvider
}

function callbackUrl(provider: IntegrationProvider): string {
  const base = process.env.PUBLIC_API_URL || process.env.PUBLIC_APP_URL || 'http://localhost:3001'
  return `${base}/api/integrations/callback/${provider.toLowerCase()}`
}

// -------------------------------------------------------------
// Status
// -------------------------------------------------------------

/**
 * Every provider, with its honest state.
 *
 * A provider with no row is listed as NOT_CONFIGURED, or CREDENTIAL_REQUIRED
 * when the deployment has no server-side credential — never omitted, and never
 * shown as connected because an environment variable happens to exist.
 */
router.get('/', requirePermission('INTEGRATION_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const rows = await listConnections(consultingFirmId)
    const byProvider = new Map(rows.map((r) => [r.provider, r]))
    const data = ALL_PROVIDERS.map((provider) => {
      const row = byProvider.get(provider)
      return row ? toConnectionDto(row) : unconnectedDto(provider)
    })
    res.json({ success: true, data })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// OAuth start
// -------------------------------------------------------------

const OAUTH_URLS: Partial<Record<IntegrationProvider, { url: string; scopes: string[]; extra?: Record<string, string> }>> = {
  QUICKBOOKS: { url: QUICKBOOKS_AUTH_URL, scopes: QUICKBOOKS_SCOPES },
  GOOGLE_CALENDAR: { url: GOOGLE_AUTH_URL, scopes: GOOGLE_SCOPES, extra: { access_type: 'offline', prompt: 'consent' } },
  MICROSOFT_CALENDAR: { url: MICROSOFT_AUTH_URL, scopes: MICROSOFT_SCOPES },
  SLACK: { url: SLACK_AUTH_URL, scopes: SLACK_SCOPES },
  DOCUSIGN: { url: DOCUSIGN_AUTH_URL, scopes: DOCUSIGN_SCOPES },
}

const CLIENT_ID_ENV: Partial<Record<IntegrationProvider, string>> = {
  QUICKBOOKS: 'QUICKBOOKS_CLIENT_ID',
  GOOGLE_CALENDAR: 'GOOGLE_CALENDAR_CLIENT_ID',
  MICROSOFT_CALENDAR: 'MICROSOFT_CLIENT_ID',
  SLACK: 'SLACK_CLIENT_ID',
  DOCUSIGN: 'DOCUSIGN_CLIENT_ID',
}

router.post('/:provider/authorize', requirePermission('INTEGRATION_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const provider = providerParam(req.params.provider.toUpperCase())
    const spec = OAUTH_URLS[provider]
    if (!spec) throw new ValidationError(`${PROVIDER_DEFINITIONS[provider].label} does not use an authorization redirect`)
    // Refused before the redirect, not after: walking an operator into an
    // authorization screen that cannot possibly complete is worse than telling
    // them what is missing.
    if (!platformConfigured(provider)) {
      throw new ValidationError(
        `${PROVIDER_DEFINITIONS[provider].label} is not configured on this deployment. Missing: ${missingEnv(provider).join(', ')}`,
      )
    }

    const redirectUri = callbackUrl(provider)
    const { state } = await startOAuthState(consultingFirmId, req.user!.userId, provider, redirectUri)
    await upsertConnection(consultingFirmId, provider, { status: IntegrationStatus.PENDING })

    const url = new URL(spec.url)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', process.env[CLIENT_ID_ENV[provider]!]!)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('scope', spec.scopes.join(provider === IntegrationProvider.SLACK ? ',' : ' '))
    url.searchParams.set('state', state)
    for (const [k, v] of Object.entries(spec.extra ?? {})) url.searchParams.set(k, v)

    await audit(req, consultingFirmId, 'UPDATE', provider, `Authorization started for ${PROVIDER_DEFINITIONS[provider].label}`)
    res.json({ success: true, data: { authorizationUrl: url.toString() } })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// OAuth callback — no session; the state carries the tenant
// -------------------------------------------------------------

callbackRouter.get('/:provider', async (req: Request, res: Response, next: NextFunction) => {
  const appUrl = process.env.PUBLIC_APP_URL || 'http://localhost:5173'
  try {
    const provider = providerParam(String(req.params.provider).toUpperCase())
    const code = typeof req.query.code === 'string' ? req.query.code : null
    const state = typeof req.query.state === 'string' ? req.query.state : null
    if (!code || !state) throw new ValidationError('The provider did not return an authorization code')

    // The tenant comes from the stored state. Nothing in this request says
    // which firm it belongs to, and nothing in it is allowed to.
    const consumed = await consumeOAuthState(state, provider)
    const redirectUri = consumed.redirectUri

    let accessToken: string
    let refreshToken: string | undefined
    let expiresAt: Date | null = null
    let scopes: string[] = []
    const config: Record<string, unknown> = {}
    let accountName: string | null = null
    let accountId: string | null = null

    if (provider === IntegrationProvider.SLACK) {
      const result = await exchangeSlackCode(code, redirectUri)
      accessToken = result.accessToken
      scopes = result.scopes
      accountName = result.teamName ?? null
      accountId = result.teamId ?? null
      if (result.channelId) { config.channelId = result.channelId; config.channelName = result.channelName }
      if (result.teamName) config.teamName = result.teamName
    } else if (provider === IntegrationProvider.GOOGLE_CALENDAR) {
      const result = await exchangeGoogleCode(code, redirectUri)
      accessToken = result.accessToken; refreshToken = result.refreshToken
      expiresAt = result.expiresAt; scopes = result.scopes
      config.calendarId = 'primary'
    } else if (provider === IntegrationProvider.MICROSOFT_CALENDAR) {
      const result = await exchangeMicrosoftCode(code, redirectUri, consumed.codeVerifier)
      accessToken = result.accessToken; refreshToken = result.refreshToken
      expiresAt = result.expiresAt; scopes = result.scopes
    } else if (provider === IntegrationProvider.DOCUSIGN) {
      const result = await exchangeDocusignCode(code, redirectUri)
      accessToken = result.accessToken; refreshToken = result.refreshToken
      expiresAt = result.expiresAt
      config.baseUrl = process.env.DOCUSIGN_BASE_URL
    } else if (provider === IntegrationProvider.QUICKBOOKS) {
      // Intuit returns the company id alongside the code, in the redirect.
      const realmId = typeof req.query.realmId === 'string' ? req.query.realmId : null
      if (!realmId) throw new ValidationError('QuickBooks did not return a company id')
      const { quickbooksConnector } = await import('../services/integrations/accounting/quickbooks')
      void quickbooksConnector
      const { providerRequest } = await import('../services/integrations/httpClient')
      const data = await providerRequest<{ access_token: string; refresh_token?: string; expires_in: number }>(
        'quickbooks.token',
        {
          method: 'POST',
          url: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
          headers: {
            Authorization: `Basic ${Buffer.from(`${process.env.QUICKBOOKS_CLIENT_ID}:${process.env.QUICKBOOKS_CLIENT_SECRET}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          data: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
        },
      )
      accessToken = data.access_token; refreshToken = data.refresh_token
      expiresAt = new Date(Date.now() + data.expires_in * 1000)
      config.realmId = realmId
      accountId = realmId
    } else {
      throw new ValidationError('That provider does not use an authorization redirect')
    }

    await upsertConnection(consumed.consultingFirmId, provider, {
      status: IntegrationStatus.CONNECTED,
      accessToken, refreshToken: refreshToken ?? null, tokenExpiresAt: expiresAt,
      grantedScopes: scopes, config, externalAccountId: accountId, externalAccountName: accountName,
      connectedByUserId: consumed.userId, lastError: null,
    })
    await logAudit({
      consultingFirmId: consumed.consultingFirmId, actorUserId: consumed.userId,
      actorKind: 'INTERNAL_USER', action: 'UPDATE', entityType: 'IntegrationConnection',
      entityId: provider, rationale: `${PROVIDER_DEFINITIONS[provider].label} connected`,
    })
    res.redirect(`${appUrl}/settings?integration=${provider.toLowerCase()}&status=connected`)
  } catch (err) {
    // The operator is redirected back with a flag; the reason goes to the log,
    // never to a query string that ends up in a proxy access log.
    logger.warn('Integration callback failed', { error: (err as Error).message })
    res.redirect(`${appUrl}/settings?integration=error`)
  }
})

// -------------------------------------------------------------
// Direct configuration (providers with no redirect)
// -------------------------------------------------------------

router.post('/teams/connect', requirePermission('INTEGRATION_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = z.object({
      webhookUrl: z.string().trim().url().max(1000),
      channelName: z.string().trim().max(200).optional(),
    }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('A Teams incoming-webhook URL is required')
    if (!isAllowedTeamsWebhook(parsed.data.webhookUrl)) {
      throw new ValidationError('That URL is not a Microsoft Teams incoming-webhook endpoint')
    }

    const row = await upsertConnection(consultingFirmId, IntegrationProvider.MICROSOFT_TEAMS, {
      status: IntegrationStatus.CONNECTED,
      // The URL is a bearer credential in URL form, so it is stored the same
      // way a token is and never returned.
      accessToken: parsed.data.webhookUrl,
      externalAccountName: parsed.data.channelName ?? null,
      config: { channelName: parsed.data.channelName ?? null, webhookConfigured: true },
      connectedByUserId: req.user?.userId ?? null,
      lastError: null,
    })
    await audit(req, consultingFirmId, 'UPDATE', row.id, 'Microsoft Teams channel connected')
    res.json({ success: true, data: toConnectionDto(row) })
  } catch (err) { next(err) }
})

const AccountingCredentialSchema = z.object({
  apiKey: z.string().trim().min(8).max(500),
  baseUrl: z.string().trim().url().max(500).optional(),
  accountId: z.string().trim().max(200).optional(),
})

router.post('/:provider/credentials', requirePermission('INTEGRATION_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const provider = providerParam(req.params.provider.toUpperCase())
    if (provider !== IntegrationProvider.UNANET && provider !== IntegrationProvider.DELTEK) {
      throw new ValidationError(`${PROVIDER_DEFINITIONS[provider].label} is connected through an authorization redirect, not an API key`)
    }
    const parsed = AccountingCredentialSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('An API key is required')

    const row = await upsertConnection(consultingFirmId, provider, {
      // Stored and encrypted like every other credential — but the connection
      // stays ERROR rather than CONNECTED, because this deployment has no
      // endpoint mapping and pretending otherwise would be the lie this whole
      // module is built to avoid.
      status: IntegrationStatus.ERROR,
      accessToken: parsed.data.apiKey,
      config: { baseUrl: parsed.data.baseUrl ?? null, accountId: parsed.data.accountId ?? null },
      connectedByUserId: req.user?.userId ?? null,
      lastError: PROVIDER_DEFINITIONS[provider].configurationNote,
    })
    await audit(req, consultingFirmId, 'UPDATE', row.id, `${PROVIDER_DEFINITIONS[provider].label} credential stored`)
    res.json({ success: true, data: toConnectionDto(row) })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Test, sync, disconnect
// -------------------------------------------------------------

router.post('/:id/test', requirePermission('INTEGRATION_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const row = await requireConnection(consultingFirmId, req.params.id)
    const credential = readCredential(row)

    let result: { ok: boolean; accountName?: string; detail: string }
    try {
      if (row.category === 'ACCOUNTING') {
        result = await connectorFor(row.provider).testConnection({
          consultingFirmId, connectionId: row.id, credential,
        })
      } else if (row.category === 'CALENDAR') {
        const adapter = calendarAdapterFor(row.provider)
        result = adapter
          ? await adapter.testConnection(credential)
          : { ok: false, detail: 'No adapter is available for this provider.' }
      } else if (row.provider === IntegrationProvider.MICROSOFT_TEAMS) {
        result = credential.accessToken
          ? { ok: true, detail: 'A webhook URL is stored. Teams accepts a message without a separate verification call.' }
          : { ok: false, detail: 'No webhook URL is stored.' }
      } else if (row.provider === IntegrationProvider.SLACK) {
        result = credential.accessToken
          ? { ok: true, detail: 'A workspace token is stored.' }
          : { ok: false, detail: 'No workspace token is stored.' }
      } else {
        const { esignAdapterFor } = await import('../services/integrations/esign/docusign')
        const adapter = esignAdapterFor(row.provider)
        result = adapter
          ? await adapter.testConnection(credential)
          : { ok: false, detail: 'No adapter is available for this provider.' }
      }
    } catch (err) {
      result = {
        ok: false,
        detail: err instanceof ConnectorError ? err.message : 'The provider could not be reached.',
      }
    }

    const updated = await prisma.integrationConnection.update({
      where: { id: row.id },
      data: result.ok
        ? {
          status: IntegrationStatus.CONNECTED, lastError: null, lastErrorAt: null,
          consecutiveFailures: 0,
          ...(result.accountName ? { externalAccountName: result.accountName } : {}),
        }
        : { status: IntegrationStatus.ERROR, lastError: result.detail.slice(0, 500), lastErrorAt: new Date() },
    })
    res.json({ success: true, data: { ...toConnectionDto(updated), test: result } })
  } catch (err) { next(err) }
})

const SyncSchema = z.object({
  invoiceIds: z.array(z.string().uuid()).max(200).optional(),
  subcontractInvoiceIds: z.array(z.string().uuid()).max(200).optional(),
  reconcilePayments: z.boolean().optional(),
})

router.post('/:id/sync', requirePermission('INTEGRATION_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const row = await requireConnection(consultingFirmId, req.params.id)

    if (row.category === 'CALENDAR') {
      const outcomes = await syncFirmMilestones(consultingFirmId, row.provider)
      await audit(req, consultingFirmId, 'UPDATE', row.id, 'Calendar sync run manually')
      return res.json({ success: true, data: { outcomes } })
    }
    if (row.category !== 'ACCOUNTING') {
      throw new ValidationError('That provider has nothing to synchronize on demand')
    }

    const parsed = SyncSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('Invalid sync request')

    const outcomes = []
    for (const id of parsed.data.invoiceIds ?? []) {
      // Built from a tenant-scoped read, so an id from another firm produces
      // nothing rather than an export.
      const payload = await buildInvoicePayload(consultingFirmId, id)
      if (!payload) { outcomes.push({ localType: 'ContractInvoice', localId: id, externalId: null, action: 'SKIPPED', detail: 'not found in this tenant' }); continue }
      outcomes.push(await exportDocument(consultingFirmId, row.provider, payload))
    }
    for (const id of parsed.data.subcontractInvoiceIds ?? []) {
      const payload = await buildSubcontractInvoicePayload(consultingFirmId, id)
      if (!payload) { outcomes.push({ localType: 'SubcontractInvoice', localId: id, externalId: null, action: 'SKIPPED', detail: 'not found in this tenant' }); continue }
      outcomes.push(await exportDocument(consultingFirmId, row.provider, payload))
    }

    const reconciliation = parsed.data.reconcilePayments
      ? await reconcilePayments(consultingFirmId, row.provider, row.lastSuccessfulSyncAt)
      : null

    await audit(req, consultingFirmId, 'UPDATE', row.id, `${PROVIDER_DEFINITIONS[row.provider].label} sync run manually`)
    res.json({ success: true, data: { outcomes, reconciliation } })
  } catch (err) { next(err) }
})

router.post('/:id/disconnect', requirePermission('INTEGRATION_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const row = await disconnectConnection(consultingFirmId, req.params.id, req.user?.userId ?? null)
    await audit(req, consultingFirmId, 'DELETE', row.id, `${PROVIDER_DEFINITIONS[row.provider].label} disconnected`)
    res.json({ success: true, data: toConnectionDto(row) })
  } catch (err) { next(err) }
})

router.get('/:id/sync-records', requirePermission('INTEGRATION_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const row = await requireConnection(consultingFirmId, req.params.id)
    const records = await prisma.integrationSyncRecord.findMany({
      where: { connectionId: row.id, consultingFirmId },
      select: { id: true, localType: true, localId: true, externalId: true, direction: true, lastSyncedAt: true, lastError: true },
      orderBy: { updatedAt: 'desc' }, take: 200,
    })
    res.json({ success: true, data: records })
  } catch (err) { next(err) }
})

export default router
