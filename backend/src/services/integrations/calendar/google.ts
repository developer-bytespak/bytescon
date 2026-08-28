// =============================================================
// §8.5 — Google Calendar adapter.
//
// A real client against the documented Calendar API v3. CREDENTIAL-GATED on
// this deployment: no Google OAuth client is configured, so every path is
// exercised against mocks and none has been run against Google's servers.
// =============================================================
import { IntegrationProvider } from '@prisma/client'
import { providerRequest } from '../httpClient'
import { ConnectorError } from '../accounting/connector'
import type { DecryptedCredential } from '../connectionService'
import type { CalendarAdapter, CalendarEventInput } from './calendarSync'

const API_BASE = process.env.GOOGLE_CALENDAR_API_BASE || 'https://www.googleapis.com/calendar/v3'

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/calendar.events']

function calendarId(cred: DecryptedCredential): string {
  const id = cred.config.calendarId
  return typeof id === 'string' && id.length > 0 ? id : 'primary'
}

function headers(cred: DecryptedCredential): Record<string, string> {
  if (!cred.accessToken) {
    throw new ConnectorError('This Google Calendar connection has no stored credential.', 'NO_CREDENTIAL')
  }
  return { Authorization: `Bearer ${cred.accessToken}`, 'Content-Type': 'application/json' }
}

function toGoogleEvent(event: CalendarEventInput): Record<string, unknown> {
  const end = event.endAt ?? event.startAt
  return {
    summary: event.title,
    description: event.description ?? undefined,
    start: event.isAllDay
      ? { date: event.startAt.toISOString().slice(0, 10) }
      : { dateTime: event.startAt.toISOString() },
    end: event.isAllDay
      // Google treats an all-day end date as exclusive.
      ? { date: new Date(end.getTime() + 86_400_000).toISOString().slice(0, 10) }
      : { dateTime: end.toISOString() },
    source: { title: 'Bytescon', url: process.env.PUBLIC_APP_URL || undefined },
  }
}

export const googleCalendarAdapter: CalendarAdapter = {
  provider: IntegrationProvider.GOOGLE_CALENDAR,

  async testConnection(cred) {
    const data = await providerRequest<{ summary?: string; id?: string }>('google.calendarGet', {
      method: 'GET',
      url: `${API_BASE}/calendars/${encodeURIComponent(calendarId(cred))}`,
      headers: headers(cred),
    })
    return { ok: true, accountName: data.summary ?? data.id, detail: 'The stored credential authenticated against the calendar.' }
  },

  async createEvent(cred, event) {
    const data = await providerRequest<{ id?: string }>('google.eventInsert', {
      method: 'POST',
      url: `${API_BASE}/calendars/${encodeURIComponent(calendarId(cred))}/events`,
      headers: headers(cred),
      data: toGoogleEvent(event),
    })
    if (!data.id) throw new ConnectorError('Google accepted the event but returned no id.', 'PROVIDER_ERROR')
    return { externalId: data.id }
  },

  async updateEvent(cred, externalId, event) {
    await providerRequest<unknown>('google.eventPatch', {
      method: 'PATCH',
      url: `${API_BASE}/calendars/${encodeURIComponent(calendarId(cred))}/events/${encodeURIComponent(externalId)}`,
      headers: headers(cred),
      data: toGoogleEvent(event),
    })
  },

  async deleteEvent(cred, externalId) {
    await providerRequest<unknown>('google.eventDelete', {
      method: 'DELETE',
      url: `${API_BASE}/calendars/${encodeURIComponent(calendarId(cred))}/events/${encodeURIComponent(externalId)}`,
      headers: headers(cred),
    })
  },
}

export async function exchangeGoogleCode(
  code: string, redirectUri: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt: Date; scopes: string[] }> {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new ConnectorError('Google Calendar is not configured on this deployment.', 'NO_CREDENTIAL')
  }
  const data = await providerRequest<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }>(
    'google.token',
    {
      method: 'POST',
      url: GOOGLE_TOKEN_URL,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: new URLSearchParams({
        code, client_id: clientId, client_secret: clientSecret,
        redirect_uri: redirectUri, grant_type: 'authorization_code',
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
