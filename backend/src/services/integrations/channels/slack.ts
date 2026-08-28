// =============================================================
// §8.5 — Slack adapter.
//
// A tenant-level connection through Slack's OAuth v2 install flow, writing
// with chat.postMessage. Deliberately NOT the ops `ALERT_WEBHOOK_URL`, which
// pages the platform operator and belongs to a different audience entirely.
//
// CREDENTIAL-GATED here: no Slack app is configured on this deployment, so the
// request shape is exercised against mocks and has not been run against
// Slack's servers.
// =============================================================
import { providerRequest } from '../httpClient'
import { ConnectorError } from '../accounting/connector'
import type { DecryptedCredential } from '../connectionService'
import type { ChannelMessage } from './dispatcher'

export const SLACK_AUTH_URL = 'https://slack.com/oauth/v2/authorize'
export const SLACK_TOKEN_URL = 'https://slack.com/api/oauth.v2.access'
export const SLACK_SCOPES = ['chat:write', 'channels:read']

interface SlackResponse {
  ok: boolean
  error?: string
  ts?: string
}

export async function postSlackMessage(
  credential: DecryptedCredential, message: ChannelMessage, url?: string,
): Promise<void> {
  if (!credential.accessToken) {
    throw new ConnectorError('This Slack connection has no stored credential.', 'NO_CREDENTIAL')
  }
  const channel = credential.config.channelId
  if (typeof channel !== 'string' || channel.length === 0) {
    throw new ConnectorError('This Slack connection has no target channel.', 'NO_CREDENTIAL')
  }

  const lines = [`*${message.title}*`, message.summary]
  if (url) lines.push(`<${url}|Open in Bytescon>`)

  const data = await providerRequest<SlackResponse>('slack.postMessage', {
    method: 'POST',
    url: 'https://slack.com/api/chat.postMessage',
    headers: {
      Authorization: `Bearer ${credential.accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    data: { channel, text: lines.join('\n') },
  })
  // Slack answers 200 with ok:false, so the HTTP layer alone is not enough.
  if (!data.ok) {
    throw new ConnectorError(`Slack rejected the message (${data.error ?? 'unknown'}).`, 'PROVIDER_ERROR')
  }
}

interface SlackOAuthResponse {
  ok: boolean
  error?: string
  access_token?: string
  scope?: string
  team?: { id?: string; name?: string }
  incoming_webhook?: { channel_id?: string; channel?: string }
}

export async function exchangeSlackCode(
  code: string, redirectUri: string,
): Promise<{ accessToken: string; teamId?: string; teamName?: string; channelId?: string; channelName?: string; scopes: string[] }> {
  const clientId = process.env.SLACK_CLIENT_ID
  const clientSecret = process.env.SLACK_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new ConnectorError('Slack is not configured on this deployment.', 'NO_CREDENTIAL')
  }
  const data = await providerRequest<SlackOAuthResponse>('slack.oauthAccess', {
    method: 'POST',
    url: SLACK_TOKEN_URL,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri,
    }).toString(),
  })
  if (!data.ok || !data.access_token) {
    throw new ConnectorError(`Slack refused the authorization (${data.error ?? 'unknown'}).`, 'PROVIDER_ERROR')
  }
  return {
    accessToken: data.access_token,
    teamId: data.team?.id,
    teamName: data.team?.name,
    channelId: data.incoming_webhook?.channel_id,
    channelName: data.incoming_webhook?.channel,
    scopes: (data.scope ?? '').split(',').filter(Boolean),
  }
}
