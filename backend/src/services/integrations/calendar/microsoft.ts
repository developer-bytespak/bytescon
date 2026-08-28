// =============================================================
// §8.5 — Microsoft 365 Calendar adapter (Graph).
//
// A real client against the documented Graph v1.0 events API.
// CREDENTIAL-GATED on this deployment: no Entra ID application is configured,
// so every path is exercised against mocks and none has been run against
// Microsoft's servers.
// =============================================================
import { IntegrationProvider } from '@prisma/client'
import { providerRequest } from '../httpClient'
import { ConnectorError } from '../accounting/connector'
import type { DecryptedCredential } from '../connectionService'
import type { CalendarAdapter, CalendarEventInput } from './calendarSync'

const API_BASE = process.env.MICROSOFT_GRAPH_BASE || 'https://graph.microsoft.com/v1.0'

export const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
export const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
export const MICROSOFT_SCOPES = ['offline_access', 'Calendars.ReadWrite', 'User.Read']

function headers(cred: DecryptedCredential): Record<string, string> {
  if (!cred.accessToken) {
    throw new ConnectorError('This Microsoft Calendar connection has no stored credential.', 'NO_CREDENTIAL')
  }
  return { Authorization: `Bearer ${cred.accessToken}`, 'Content-Type': 'application/json' }
}

function eventsPath(cred: DecryptedCredential): string {
  const calendarId = cred.config.calendarId
  return typeof calendarId === 'string' && calendarId.length > 0
    ? `${API_BASE}/me/calendars/${encodeURIComponent(calendarId)}/events`
    : `${API_BASE}/me/events`
}

function toGraphEvent(event: CalendarEventInput): Record<string, unknown> {
  const end = event.endAt ?? event.startAt
  return {
    subject: event.title,
    body: { contentType: 'text', content: event.description ?? '' },
    isAllDay: event.isAllDay,
    start: event.isAllDay
      ? { dateTime: `${event.startAt.toISOString().slice(0, 10)}T00:00:00`, timeZone: 'UTC' }
      : { dateTime: event.startAt.toISOString(), timeZone: 'UTC' },
    end: event.isAllDay
      ? { dateTime: `${new Date(end.getTime() + 86_400_000).toISOString().slice(0, 10)}T00:00:00`, timeZone: 'UTC' }
      : { dateTime: end.toISOString(), timeZone: 'UTC' },
  }
}

export const microsoftCalendarAdapter: CalendarAdapter = {
  provider: IntegrationProvider.MICROSOFT_CALENDAR,

  async testConnection(cred) {
    const data = await providerRequest<{ displayName?: string; userPrincipalName?: string }>('microsoft.me', {
      method: 'GET', url: `${API_BASE}/me`, headers: headers(cred),
    })
    return {
      ok: true,
      accountName: data.displayName ?? data.userPrincipalName,
      detail: 'The stored credential authenticated against Microsoft Graph.',
    }
  },

  async createEvent(cred, event) {
    const data = await providerRequest<{ id?: string }>('microsoft.eventCreate', {
      method: 'POST', url: eventsPath(cred), headers: headers(cred), data: toGraphEvent(event),
    })
    if (!data.id) throw new ConnectorError('Microsoft accepted the event but returned no id.', 'PROVIDER_ERROR')
    return { externalId: data.id }
  },

  async updateEvent(cred, externalId, event) {
    await providerRequest<unknown>('microsoft.eventPatch', {
      method: 'PATCH',
      url: `${eventsPath(cred)}/${encodeURIComponent(externalId)}`,
      headers: headers(cred), data: toGraphEvent(event),
    })
  },

  async deleteEvent(cred, externalId) {
    await providerRequest<unknown>('microsoft.eventDelete', {
      method: 'DELETE',
      url: `${eventsPath(cred)}/${encodeURIComponent(externalId)}`,
      headers: headers(cred),
    })
  },
}

export async function exchangeMicrosoftCode(
  code: string, redirectUri: string, codeVerifier: string | null,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt: Date; scopes: string[] }> {
  const clientId = process.env.MICROSOFT_CLIENT_ID
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new ConnectorError('Microsoft is not configured on this deployment.', 'NO_CREDENTIAL')
  }
  const data = await providerRequest<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }>(
    'microsoft.token',
    {
      method: 'POST',
      url: MICROSOFT_TOKEN_URL,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: new URLSearchParams({
        code, client_id: clientId, client_secret: clientSecret,
        redirect_uri: redirectUri, grant_type: 'authorization_code',
        ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
      }).toString(),
    },
  )
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    scopes: (data.scope ?? '').split(' ').filter(Boolean),
  }
}
