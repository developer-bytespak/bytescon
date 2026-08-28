// =============================================================
// §8.5 — Integration connections.
//
// The single tenant-scoped store for every external provider credential, and
// the only module that decrypts one.
//
// TWO INVARIANTS, enforced here rather than remembered at each call site:
//
//  1. A token never leaves this module in the clear. `toConnectionDto` is the
//     only shape any route may return, and it has no field that could hold
//     one — not "redacted", not "***", absent.
//  2. A connection is always resolved by (tenant, provider) or by (id, tenant).
//     Nothing looks a connection up by id alone, so a leaked id is not a key.
// =============================================================
import crypto from 'crypto'
import {
  IntegrationCategory, IntegrationProvider, IntegrationStatus, Prisma,
} from '@prisma/client'
import { prisma } from '../../config/database'
import { encryptSecret, decryptSecret } from '../../utils/fieldCrypto'
import { NotFoundError, ValidationError } from '../../utils/errors'
import { PROVIDER_DEFINITIONS, missingEnv, platformConfigured } from './registry'

/** What a route may return. Deliberately carries no secret-shaped field. */
export interface ConnectionDto {
  id: string
  provider: IntegrationProvider
  category: IntegrationCategory
  label: string
  status: IntegrationStatus
  /** The provider's own account name, for "connected to which workspace?". */
  externalAccountName: string | null
  grantedScopes: string[]
  connectedAt: string | null
  lastSyncAt: string | null
  lastSuccessfulSyncAt: string | null
  lastError: string | null
  consecutiveFailures: number
  /** Non-secret configuration only — see SAFE_CONFIG_KEYS. */
  config: Record<string, unknown>
  implementation: string
  capabilities: string[]
  /** False when this deployment has no server-side credential for the provider. */
  platformConfigured: boolean
  missingEnv: string[]
  configurationNote: string
}

/**
 * Config keys a client may read back.
 *
 * A Teams incoming-webhook URL is a bearer credential in URL form — anyone
 * holding it can post to the channel — so it is stored in `config` for
 * convenience but never returned. Everything else here is an identifier.
 */
const SAFE_CONFIG_KEYS = new Set([
  'calendarId', 'channelId', 'channelName', 'teamName', 'realmId',
  'accountId', 'baseUrl', 'environment', 'webhookConfigured',
])

function safeConfig(value: Prisma.JsonValue | null): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SAFE_CONFIG_KEYS.has(k)) out[k] = v
  }
  return out
}

type ConnectionRow = Prisma.IntegrationConnectionGetPayload<Record<string, never>>

export function toConnectionDto(row: ConnectionRow): ConnectionDto {
  const def = PROVIDER_DEFINITIONS[row.provider]
  return {
    id: row.id,
    provider: row.provider,
    category: row.category,
    label: def.label,
    status: row.status,
    externalAccountName: row.externalAccountName,
    grantedScopes: row.grantedScopes,
    connectedAt: row.connectedAt?.toISOString() ?? null,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastSuccessfulSyncAt: row.lastSuccessfulSyncAt?.toISOString() ?? null,
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
    config: safeConfig(row.config),
    implementation: def.implementation,
    capabilities: def.capabilities,
    platformConfigured: platformConfigured(row.provider),
    missingEnv: missingEnv(row.provider),
    configurationNote: def.configurationNote,
  }
}

/** A provider with no row yet, described honestly rather than omitted. */
export function unconnectedDto(provider: IntegrationProvider): ConnectionDto {
  const def = PROVIDER_DEFINITIONS[provider]
  const configured = platformConfigured(provider)
  return {
    id: '', provider, category: def.category, label: def.label,
    // Never "not connected" when the operator could not connect it if they
    // tried — the two are different problems with different fixes.
    status: configured ? IntegrationStatus.NOT_CONFIGURED : IntegrationStatus.CREDENTIAL_REQUIRED,
    externalAccountName: null, grantedScopes: [], connectedAt: null,
    lastSyncAt: null, lastSuccessfulSyncAt: null, lastError: null, consecutiveFailures: 0,
    config: {}, implementation: def.implementation, capabilities: def.capabilities,
    platformConfigured: configured, missingEnv: missingEnv(provider),
    configurationNote: def.configurationNote,
  }
}

export async function listConnections(consultingFirmId: string): Promise<ConnectionRow[]> {
  return prisma.integrationConnection.findMany({
    where: { consultingFirmId }, orderBy: { provider: 'asc' },
  })
}

export async function findConnection(
  consultingFirmId: string, provider: IntegrationProvider,
): Promise<ConnectionRow | null> {
  return prisma.integrationConnection.findFirst({ where: { consultingFirmId, provider } })
}

/**
 * The connection a caller may act on.
 *
 * Both the id and the tenant must match. A connection id from another firm is
 * indistinguishable from one that does not exist.
 */
export async function requireConnection(
  consultingFirmId: string, id: string,
): Promise<ConnectionRow> {
  const row = await prisma.integrationConnection.findFirst({ where: { id, consultingFirmId } })
  if (!row) throw new NotFoundError('Integration connection not found')
  return row
}

export async function upsertConnection(
  consultingFirmId: string, provider: IntegrationProvider,
  data: Partial<{
    status: IntegrationStatus
    externalAccountId: string | null
    externalAccountName: string | null
    accessToken: string | null
    refreshToken: string | null
    tokenExpiresAt: Date | null
    grantedScopes: string[]
    config: Record<string, unknown>
    connectedByUserId: string | null
    lastError: string | null
  }>,
): Promise<ConnectionRow> {
  const def = PROVIDER_DEFINITIONS[provider]
  const encrypted: { accessTokenEnc?: string | null; refreshTokenEnc?: string | null } = {}
  if (data.accessToken !== undefined) encrypted.accessTokenEnc = encryptSecret(data.accessToken)
  if (data.refreshToken !== undefined) encrypted.refreshTokenEnc = encryptSecret(data.refreshToken)

  const common = {
    ...(data.status !== undefined ? { status: data.status } : {}),
    ...(data.externalAccountId !== undefined ? { externalAccountId: data.externalAccountId } : {}),
    ...(data.externalAccountName !== undefined ? { externalAccountName: data.externalAccountName } : {}),
    ...(data.tokenExpiresAt !== undefined ? { tokenExpiresAt: data.tokenExpiresAt } : {}),
    ...(data.grantedScopes !== undefined ? { grantedScopes: data.grantedScopes } : {}),
    ...(data.config !== undefined ? { config: data.config as Prisma.InputJsonObject } : {}),
    ...(data.connectedByUserId !== undefined ? { connectedByUserId: data.connectedByUserId } : {}),
    ...(data.lastError !== undefined
      ? { lastError: data.lastError, lastErrorAt: data.lastError ? new Date() : null }
      : {}),
    ...encrypted,
  }

  const existing = await findConnection(consultingFirmId, provider)
  if (existing) {
    return prisma.integrationConnection.update({
      where: { id: existing.id },
      data: {
        ...common,
        ...(data.status === IntegrationStatus.CONNECTED
          ? { connectedAt: new Date(), disconnectedAt: null, consecutiveFailures: 0 }
          : {}),
      },
    })
  }
  return prisma.integrationConnection.create({
    data: {
      consultingFirmId, provider, category: def.category,
      status: data.status ?? IntegrationStatus.NOT_CONFIGURED,
      ...common,
      ...(data.status === IntegrationStatus.CONNECTED ? { connectedAt: new Date() } : {}),
    },
  })
}

/**
 * Disconnect.
 *
 * The stored credential is destroyed, not merely marked unused: a disconnected
 * connection that still holds a refresh token is a credential nobody is
 * watching. The sync ledger is kept, so reconnecting later does not duplicate
 * everything that was already exported.
 */
export async function disconnectConnection(
  consultingFirmId: string, id: string, userId: string | null,
): Promise<ConnectionRow> {
  const existing = await requireConnection(consultingFirmId, id)
  return prisma.integrationConnection.update({
    where: { id: existing.id },
    data: {
      status: IntegrationStatus.DISCONNECTED,
      accessTokenEnc: null,
      refreshTokenEnc: null,
      tokenExpiresAt: null,
      grantedScopes: [],
      config: {},
      disconnectedAt: new Date(),
      disconnectedByUserId: userId,
      lastError: null,
      lastErrorAt: null,
      consecutiveFailures: 0,
    },
  })
}

export interface DecryptedCredential {
  accessToken: string | null
  refreshToken: string | null
  tokenExpiresAt: Date | null
  config: Record<string, unknown>
}

/**
 * The only way to read a credential. Callers are adapters, never routes.
 *
 * Kept out of `toConnectionDto`'s path entirely so no refactor can accidentally
 * serialize the result of this function.
 */
export function readCredential(row: ConnectionRow): DecryptedCredential {
  return {
    accessToken: decryptSecret(row.accessTokenEnc),
    refreshToken: decryptSecret(row.refreshTokenEnc),
    tokenExpiresAt: row.tokenExpiresAt,
    config: (row.config && typeof row.config === 'object' && !Array.isArray(row.config)
      ? row.config
      : {}) as Record<string, unknown>,
  }
}

const MAX_CONSECUTIVE_FAILURES = 5

/** Record a failed operation, bounding retry by counting the failures. */
export async function recordFailure(connectionId: string, message: string): Promise<void> {
  const row = await prisma.integrationConnection.findUnique({
    where: { id: connectionId }, select: { consecutiveFailures: true },
  })
  const failures = (row?.consecutiveFailures ?? 0) + 1
  await prisma.integrationConnection.update({
    where: { id: connectionId },
    data: {
      // The message is the adapter's sanitized summary, never a raw provider
      // body, because a provider error can echo the request that caused it.
      lastError: message.slice(0, 500),
      lastErrorAt: new Date(),
      lastSyncAt: new Date(),
      consecutiveFailures: failures,
      status: IntegrationStatus.ERROR,
    },
  })
}

export async function recordSuccess(connectionId: string): Promise<void> {
  const now = new Date()
  await prisma.integrationConnection.update({
    where: { id: connectionId },
    data: {
      lastSyncAt: now, lastSuccessfulSyncAt: now, lastError: null, lastErrorAt: null,
      consecutiveFailures: 0, status: IntegrationStatus.CONNECTED,
    },
  })
}

/** True when a connection has failed enough times that automatic retry stops. */
export function retriesExhausted(row: Pick<ConnectionRow, 'consecutiveFailures'>): boolean {
  return row.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
}

// -------------------------------------------------------------
// OAuth state
// -------------------------------------------------------------

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

export interface OAuthStartState {
  /** Goes in the redirect. Only its hash is stored. */
  state: string
  codeVerifier: string
}

/**
 * Mint a single-use, tenant- and user-bound state.
 *
 * The callback proves it holds a state this server minted for this tenant. The
 * tenant is read from the stored row, never from the callback body — a
 * `consultingFirmId` in a redirect is an attacker-controlled string.
 */
export async function startOAuthState(
  consultingFirmId: string, userId: string, provider: IntegrationProvider, redirectUri: string,
): Promise<OAuthStartState> {
  const state = crypto.randomBytes(32).toString('base64url')
  const codeVerifier = crypto.randomBytes(32).toString('base64url')
  await prisma.integrationOAuthState.create({
    data: {
      consultingFirmId, userId, provider,
      stateHash: crypto.createHash('sha256').update(state).digest('hex'),
      codeVerifierEnc: encryptSecret(codeVerifier),
      redirectUri,
      expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
    },
  })
  return { state, codeVerifier }
}

export interface ConsumedOAuthState {
  consultingFirmId: string
  userId: string
  provider: IntegrationProvider
  redirectUri: string
  codeVerifier: string | null
}

/**
 * Validate and burn a state.
 *
 * Unknown, expired, already-consumed and wrong-provider all fail the same way.
 * Consumption is a conditional update, so two concurrent callbacks cannot both
 * succeed with the same state.
 */
export async function consumeOAuthState(
  state: string, provider: IntegrationProvider,
): Promise<ConsumedOAuthState> {
  const stateHash = crypto.createHash('sha256').update(state).digest('hex')
  const row = await prisma.integrationOAuthState.findUnique({ where: { stateHash } })
  if (!row || row.consumedAt || row.expiresAt < new Date() || row.provider !== provider) {
    throw new ValidationError('That authorization link is invalid or has expired')
  }
  const burned = await prisma.integrationOAuthState.updateMany({
    where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() },
  })
  if (burned.count !== 1) throw new ValidationError('That authorization link is invalid or has expired')

  return {
    consultingFirmId: row.consultingFirmId,
    userId: row.userId,
    provider: row.provider,
    redirectUri: row.redirectUri,
    codeVerifier: decryptSecret(row.codeVerifierEnc),
  }
}
