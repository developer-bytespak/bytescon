// =============================================================
// §8.5 — Microsoft Teams adapter.
//
// An incoming-webhook URL the customer pastes in, which needs no platform-side
// application registration — so unlike the other providers this one can be
// connected on a deployment with no vendor credentials at all.
//
// THE URL IS A CREDENTIAL. Anyone holding it can post into the channel, so it
// is stored encrypted like a token and is never returned by any DTO, never
// logged, and never written into an audit row.
// =============================================================
import { providerRequest } from '../httpClient'
import { ConnectorError } from '../accounting/connector'
import type { DecryptedCredential } from '../connectionService'
import type { ChannelMessage } from './dispatcher'

/** Only Microsoft's own webhook hosts. A pasted URL is untrusted input. */
const ALLOWED_HOST_SUFFIXES = [
  '.webhook.office.com',
  '.office.com',
  '.microsoft.com',
  '.logic.azure.com',
]

/**
 * Accept only a webhook URL that is plausibly Microsoft's.
 *
 * Without this the field is a server-side request forgery: an operator pastes
 * a URL and the platform makes an authenticated-looking POST to it from inside
 * the network on every notification.
 */
export function isAllowedTeamsWebhook(raw: string): boolean {
  let url: URL
  try { url = new URL(raw) } catch { return false }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  return ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

export async function postTeamsMessage(
  credential: DecryptedCredential, message: ChannelMessage, url?: string,
): Promise<void> {
  const webhookUrl = credential.accessToken
  if (!webhookUrl) {
    throw new ConnectorError('This Teams connection has no stored webhook URL.', 'NO_CREDENTIAL')
  }
  // Re-checked at send time: a URL stored before the allowlist existed, or
  // edited directly in the database, must not be posted to.
  if (!isAllowedTeamsWebhook(webhookUrl)) {
    throw new ConnectorError('The stored Teams webhook URL is not a Microsoft endpoint.', 'PROVIDER_ERROR')
  }

  const card = {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    summary: message.title,
    themeColor: message.severity === 'CRITICAL' ? 'DC2626' : message.severity === 'WARNING' ? 'F59E0B' : '2563EB',
    title: message.title,
    text: message.summary,
    ...(url ? { potentialAction: [{ '@type': 'OpenUri', name: 'Open in Bytescon', targets: [{ os: 'default', uri: url }] }] } : {}),
  }

  await providerRequest<unknown>('teams.postMessage', {
    method: 'POST',
    url: webhookUrl,
    headers: { 'Content-Type': 'application/json' },
    data: card,
  })
}
