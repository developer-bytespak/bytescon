// =============================================================
// §8.5 — Outbound notification channels.
//
// NOT a second notification system. Everything still originates from
// notifyUser(), which owns the in-app feed and its dedupe key; this module
// only asks "should this also go somewhere else, and where?".
//
// WHAT IS DELIBERATELY NOT SENT: no document body, no financial detail, no
// credential, no personal data beyond a name already visible in the platform.
// A chat message says what happened and links back — the platform stays the
// place where the thing is actually read. A Slack channel is not an access
// control boundary, and treating it as one is how a private evaluation ends up
// in a room the whole company is in.
//
// The ops webhook (ALERT_WEBHOOK_URL, alertService) is a separate thing and
// stays separate: it pages the operator of the platform, not the customer.
// =============================================================
import { IntegrationProvider, IntegrationStatus } from '@prisma/client'
import { prisma } from '../../../config/database'
import { logger } from '../../../utils/logger'
import { findConnection, readCredential, recordFailure, recordSuccess } from '../connectionService'
import { postSlackMessage } from './slack'
import { postTeamsMessage } from './teams'
import { ConnectorError } from '../accounting/connector'

export type ChannelKind = 'IN_APP' | 'EMAIL' | 'SLACK' | 'TEAMS'

export interface ChannelMessage {
  consultingFirmId: string
  /** Short subject line. */
  title: string
  /** One or two sentences. Never a document body. */
  summary: string
  /** Relative path into the platform, e.g. /contracts/abc. */
  linkPath?: string
  /** Stable key so a repeated dispatch sends once. */
  dedupeKey: string
  severity?: 'INFO' | 'WARNING' | 'CRITICAL'
}

export interface ChannelResult {
  channel: ChannelKind
  delivered: boolean
  reason?: string
}

/**
 * Values that must never reach a chat channel, checked before dispatch.
 *
 * Belt and braces on top of the caller writing a safe summary: a caller that
 * accidentally interpolates a token gets a refused send and a log line, rather
 * than a credential in a channel history that cannot be un-posted.
 */
const SECRET_SHAPED = [
  /Bearer\s+[A-Za-z0-9._-]{16,}/i,
  /\b(?:sk|pk|rk)_[A-Za-z0-9]{16,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
]

export function looksLikeSecret(text: string): boolean {
  return SECRET_SHAPED.some((pattern) => pattern.test(text))
}

function publicUrl(linkPath?: string): string | undefined {
  if (!linkPath) return undefined
  const base = process.env.PUBLIC_APP_URL || 'http://localhost:5173'
  return `${base}${linkPath.startsWith('/') ? '' : '/'}${linkPath}`
}

const DISPATCH_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Has this exact message already gone to this channel?
 *
 * Reuses IntegrationEvent as the dedupe ledger rather than adding a table: the
 * unique (provider, externalEventId) constraint is exactly the guarantee
 * needed, and a second dispatch loses the insert race instead of sending
 * twice.
 */
async function claimDispatch(
  consultingFirmId: string, provider: IntegrationProvider, dedupeKey: string,
): Promise<boolean> {
  const externalEventId = `dispatch:${dedupeKey}`
  try {
    await prisma.integrationEvent.create({
      data: {
        consultingFirmId, provider, externalEventId,
        // Lower-case on purpose: SCREAMING_SNAKE `eventType` values are the
        // Section 7 agent event vocabulary, and an integration event is not one
        // of those. Provider event names are lower-case too, so this matches
        // what actually arrives on the inbound side.
        eventType: 'outbound-notification', outcome: 'claimed',
      },
    })
    return true
  } catch {
    // Unique violation — someone already claimed it. Expired claims are swept
    // by the cleanup below so a legitimate repeat a day later still sends.
    const existing = await prisma.integrationEvent.findUnique({
      where: { provider_externalEventId: { provider, externalEventId } },
      select: { id: true, createdAt: true },
    })
    if (existing && Date.now() - existing.createdAt.getTime() > DISPATCH_TTL_MS) {
      await prisma.integrationEvent.update({
        where: { id: existing.id }, data: { createdAt: new Date() },
      })
      return true
    }
    return false
  }
}

/**
 * Send to one chat channel, if the tenant has connected it.
 *
 * An unconfigured channel is not an error: it returns `delivered: false` with
 * a reason, and the caller's in-app notification has already happened. A chat
 * integration that can take a business action down with it is worse than no
 * chat integration.
 */
export async function dispatchToChannel(
  provider: IntegrationProvider, message: ChannelMessage,
): Promise<ChannelResult> {
  const channel: ChannelKind = provider === IntegrationProvider.SLACK ? 'SLACK' : 'TEAMS'

  if (looksLikeSecret(`${message.title}\n${message.summary}`)) {
    logger.error('Refused to dispatch a notification that contains secret-shaped text', {
      consultingFirmId: message.consultingFirmId, provider,
    })
    return { channel, delivered: false, reason: 'The message was refused because it contains credential-shaped text.' }
  }

  const connection = await findConnection(message.consultingFirmId, provider)
  if (!connection || connection.status !== IntegrationStatus.CONNECTED) {
    return { channel, delivered: false, reason: 'not connected' }
  }

  if (!(await claimDispatch(message.consultingFirmId, provider, message.dedupeKey))) {
    return { channel, delivered: false, reason: 'already sent' }
  }

  const credential = readCredential(connection)
  try {
    const url = publicUrl(message.linkPath)
    if (provider === IntegrationProvider.SLACK) await postSlackMessage(credential, message, url)
    else await postTeamsMessage(credential, message, url)
    await recordSuccess(connection.id)
    await prisma.integrationEvent.updateMany({
      where: { provider, externalEventId: `dispatch:${message.dedupeKey}` },
      data: { processedAt: new Date(), outcome: 'delivered' },
    })
    return { channel, delivered: true }
  } catch (err) {
    const reason = err instanceof ConnectorError ? err.message : 'The channel rejected the message.'
    await recordFailure(connection.id, reason)
    await prisma.integrationEvent.updateMany({
      where: { provider, externalEventId: `dispatch:${message.dedupeKey}` },
      data: { processedAt: new Date(), outcome: 'failed', error: reason },
    })
    return { channel, delivered: false, reason }
  }
}

/**
 * Fan out to every chat channel the tenant has connected.
 *
 * In-app and email are untouched here: they are already handled by
 * notifyUser() and the mailer, and re-implementing them would be the second
 * notification system this module exists to avoid.
 */
export async function dispatchExternalChannels(message: ChannelMessage): Promise<ChannelResult[]> {
  const results: ChannelResult[] = []
  for (const provider of [IntegrationProvider.SLACK, IntegrationProvider.MICROSOFT_TEAMS]) {
    results.push(await dispatchToChannel(provider, message))
  }
  return results
}
