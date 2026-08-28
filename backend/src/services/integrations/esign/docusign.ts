// =============================================================
// §8.5 — DocuSign adapter.
//
// A real client against the documented eSignature REST API v2.1.
// CREDENTIAL-GATED on this deployment: no DocuSign integration key is
// configured, so the request shape is exercised against mocks and has not been
// run against DocuSign's servers, sandbox or otherwise.
// =============================================================
import { IntegrationProvider } from '@prisma/client'
import { providerRequest } from '../httpClient'
import { ConnectorError } from '../accounting/connector'
import type { DecryptedCredential } from '../connectionService'

export const DOCUSIGN_AUTH_URL = 'https://account.docusign.com/oauth/auth'
export const DOCUSIGN_TOKEN_URL = 'https://account.docusign.com/oauth/token'
export const DOCUSIGN_SCOPES = ['signature', 'extended']

export interface EnvelopeSigner {
  name: string
  email: string
  routingOrder: number
}

export interface SendEnvelopeInput {
  subject: string
  documentName: string
  /** Base64 document content. */
  documentBase64: string
  signers: EnvelopeSigner[]
}

export interface EsignAdapter {
  provider: IntegrationProvider
  testConnection(cred: DecryptedCredential): Promise<{ ok: boolean; accountName?: string; detail: string }>
  sendEnvelope(cred: DecryptedCredential, input: SendEnvelopeInput): Promise<{ externalEnvelopeId: string; providerStatus: string }>
  voidEnvelope(cred: DecryptedCredential, envelopeId: string, reason: string): Promise<void>
}

function accountBase(cred: DecryptedCredential): string {
  const base = cred.config.baseUrl ?? process.env.DOCUSIGN_BASE_URL
  const accountId = cred.config.accountId
  if (typeof base !== 'string' || typeof accountId !== 'string') {
    throw new ConnectorError('This DocuSign connection has no account base URL.', 'NO_CREDENTIAL')
  }
  return `${base.replace(/\/$/, '')}/restapi/v2.1/accounts/${accountId}`
}

function headers(cred: DecryptedCredential): Record<string, string> {
  if (!cred.accessToken) {
    throw new ConnectorError('This DocuSign connection has no stored credential.', 'NO_CREDENTIAL')
  }
  return { Authorization: `Bearer ${cred.accessToken}`, 'Content-Type': 'application/json' }
}

export const docusignAdapter: EsignAdapter = {
  provider: IntegrationProvider.DOCUSIGN,

  async testConnection(cred) {
    const data = await providerRequest<{ accountName?: string }>('docusign.account', {
      method: 'GET', url: accountBase(cred), headers: headers(cred),
    })
    return { ok: true, accountName: data.accountName, detail: 'The stored credential authenticated against the DocuSign account.' }
  },

  async sendEnvelope(cred, input) {
    const data = await providerRequest<{ envelopeId?: string; status?: string }>('docusign.createEnvelope', {
      method: 'POST',
      url: `${accountBase(cred)}/envelopes`,
      headers: headers(cred),
      data: {
        emailSubject: input.subject,
        // 'sent' is what makes it a real send. A person chose this by pressing
        // send; nothing here decides it.
        status: 'sent',
        documents: [{
          documentBase64: input.documentBase64,
          name: input.documentName,
          fileExtension: 'pdf',
          documentId: '1',
        }],
        recipients: {
          signers: input.signers.map((s, index) => ({
            email: s.email,
            name: s.name,
            recipientId: String(index + 1),
            routingOrder: String(s.routingOrder),
          })),
        },
      },
    })
    if (!data.envelopeId) throw new ConnectorError('DocuSign accepted the envelope but returned no id.', 'PROVIDER_ERROR')
    return { externalEnvelopeId: data.envelopeId, providerStatus: data.status ?? 'sent' }
  },

  async voidEnvelope(cred, envelopeId, reason) {
    await providerRequest<unknown>('docusign.voidEnvelope', {
      method: 'PUT',
      url: `${accountBase(cred)}/envelopes/${encodeURIComponent(envelopeId)}`,
      headers: headers(cred),
      data: { status: 'voided', voidedReason: reason.slice(0, 200) },
    })
  },
}

const ADAPTERS: Partial<Record<IntegrationProvider, EsignAdapter>> = { DOCUSIGN: docusignAdapter }

export function esignAdapterFor(provider: IntegrationProvider): EsignAdapter | null {
  return ADAPTERS[provider] ?? null
}

/** Test seam — the suite drives the envelope lifecycle without a live account. */
export function __setEsignAdapter(provider: IntegrationProvider, adapter: EsignAdapter | null): void {
  if (adapter) ADAPTERS[provider] = adapter
  else delete ADAPTERS[provider]
}

export async function exchangeDocusignCode(
  code: string, redirectUri: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt: Date }> {
  const clientId = process.env.DOCUSIGN_CLIENT_ID
  const clientSecret = process.env.DOCUSIGN_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new ConnectorError('DocuSign is not configured on this deployment.', 'NO_CREDENTIAL')
  }
  const data = await providerRequest<{ access_token: string; refresh_token?: string; expires_in: number }>(
    'docusign.token',
    {
      method: 'POST',
      url: DOCUSIGN_TOKEN_URL,
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
    },
  )
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  }
}
