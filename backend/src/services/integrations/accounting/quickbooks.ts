// =============================================================
// §8.5 — QuickBooks Online adapter.
//
// A real client against Intuit's documented OAuth 2.0 and Accounting API v3.
// It is nonetheless CREDENTIAL-GATED in this deployment: no Intuit app is
// configured, so every path here is exercised against mocks and none of it has
// been run against Intuit's servers. That distinction is reported rather than
// blurred.
//
// IDEMPOTENCY is carried by `DocNumber`, which QuickBooks treats as the
// document's own identifier: the adapter queries for an existing document with
// that number before creating one, so a retried export reconciles to the same
// object instead of creating a second invoice.
// =============================================================
import { IntegrationProvider } from '@prisma/client'
import { providerRequest } from '../httpClient'
import {
  ConnectorError,
  type AccountingConnector, type ConnectionTestResult, type ConnectorContext,
  type ExportPayload, type ExportResult, type RemotePayment,
} from './connector'

const API_BASE = process.env.QUICKBOOKS_API_BASE || 'https://quickbooks.api.intuit.com'
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
const MINOR_VERSION = '70'

export const QUICKBOOKS_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2'
export const QUICKBOOKS_SCOPES = ['com.intuit.quickbooks.accounting']

function realmId(ctx: ConnectorContext): string {
  const value = ctx.credential.config.realmId
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConnectorError('This QuickBooks connection has no company (realm) id.', 'NO_CREDENTIAL')
  }
  return value
}

function authHeaders(ctx: ConnectorContext): Record<string, string> {
  if (!ctx.credential.accessToken) {
    throw new ConnectorError('This QuickBooks connection has no stored credential.', 'NO_CREDENTIAL')
  }
  return {
    Authorization: `Bearer ${ctx.credential.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
}

function apiUrl(ctx: ConnectorContext, path: string): string {
  return `${API_BASE}/v3/company/${realmId(ctx)}/${path}`
}

/** Single-quote escaping for a QuickBooks query literal. */
function q(value: string): string {
  return value.replace(/'/g, "\\'")
}

interface QboQueryResponse {
  QueryResponse?: {
    Invoice?: Array<{ Id: string; DocNumber?: string }>
    Bill?: Array<{ Id: string; DocNumber?: string }>
    Purchase?: Array<{ Id: string; DocNumber?: string }>
    Payment?: Array<{
      Id: string; TotalAmt?: number; TxnDate?: string; PaymentRefNum?: string
      Line?: Array<{ LinkedTxn?: Array<{ TxnId?: string; TxnType?: string }> }>
    }>
    CompanyInfo?: Array<{ CompanyName?: string; Id?: string }>
  }
}

const ENTITY_FOR: Record<ExportPayload['localType'], 'Invoice' | 'Bill'> = {
  ContractInvoice: 'Invoice',
  SubcontractInvoice: 'Bill',
  ContractCost: 'Bill',
}

export const quickbooksConnector: AccountingConnector = {
  provider: IntegrationProvider.QUICKBOOKS,

  async testConnection(ctx: ConnectorContext): Promise<ConnectionTestResult> {
    const data = await providerRequest<QboQueryResponse>('quickbooks.companyInfo', {
      method: 'GET',
      url: apiUrl(ctx, `query?minorversion=${MINOR_VERSION}`),
      params: { query: 'select * from CompanyInfo' },
      headers: authHeaders(ctx),
    })
    const company = data.QueryResponse?.CompanyInfo?.[0]
    return {
      ok: true,
      accountName: company?.CompanyName,
      accountId: company?.Id ?? realmId(ctx),
      detail: 'The stored credential authenticated against the QuickBooks company.',
    }
  },

  async exportDocument(ctx: ConnectorContext, payload: ExportPayload): Promise<ExportResult> {
    const entity = ENTITY_FOR[payload.localType]

    // Idempotency, before anything is created: DocNumber carries our own
    // document number, so a retry finds what the first attempt made.
    const existing = await providerRequest<QboQueryResponse>('quickbooks.findExisting', {
      method: 'GET',
      url: apiUrl(ctx, `query?minorversion=${MINOR_VERSION}`),
      params: { query: `select Id, DocNumber from ${entity} where DocNumber = '${q(payload.documentNumber)}'` },
      headers: authHeaders(ctx),
    })
    const found = (existing.QueryResponse?.Invoice ?? existing.QueryResponse?.Bill ?? [])[0]
    if (found?.Id) {
      return { externalId: found.Id, externalType: entity, deduped: true }
    }

    const body = entity === 'Invoice'
      ? {
        DocNumber: payload.documentNumber,
        TxnDate: payload.issuedOn?.toISOString().slice(0, 10),
        DueDate: payload.dueOn?.toISOString().slice(0, 10),
        CustomerRef: { name: payload.counterpartyName },
        PrivateNote: payload.memo,
        Line: payload.lines.map((line) => ({
          DetailType: 'SalesItemLineDetail',
          Amount: Number(line.amount),
          Description: line.description,
          SalesItemLineDetail: {},
        })),
      }
      : {
        DocNumber: payload.documentNumber,
        TxnDate: payload.issuedOn?.toISOString().slice(0, 10),
        DueDate: payload.dueOn?.toISOString().slice(0, 10),
        VendorRef: { name: payload.counterpartyName },
        PrivateNote: payload.memo,
        Line: payload.lines.map((line) => ({
          DetailType: 'AccountBasedExpenseLineDetail',
          Amount: Number(line.amount),
          Description: line.description,
          AccountBasedExpenseLineDetail: {},
        })),
      }

    const created = await providerRequest<Record<string, { Id?: string }>>('quickbooks.create', {
      method: 'POST',
      url: apiUrl(ctx, `${entity.toLowerCase()}?minorversion=${MINOR_VERSION}`),
      headers: authHeaders(ctx),
      data: body,
    })
    const id = created[entity]?.Id
    if (!id) throw new ConnectorError('QuickBooks accepted the document but returned no id.', 'PROVIDER_ERROR')
    return { externalId: id, externalType: entity, deduped: false }
  },

  async fetchPayments(ctx: ConnectorContext, since: Date | null): Promise<RemotePayment[]> {
    const filter = since ? ` where MetaData.LastUpdatedTime > '${since.toISOString()}'` : ''
    const data = await providerRequest<QboQueryResponse>('quickbooks.payments', {
      method: 'GET',
      url: apiUrl(ctx, `query?minorversion=${MINOR_VERSION}`),
      params: { query: `select * from Payment${filter}` },
      headers: authHeaders(ctx),
    })
    const payments: RemotePayment[] = []
    for (const row of data.QueryResponse?.Payment ?? []) {
      // A payment not linked to an invoice cannot be reconciled to one of ours,
      // so it is skipped rather than guessed at.
      const linked = row.Line?.flatMap((l) => l.LinkedTxn ?? []).find((t) => t.TxnType === 'Invoice')
      if (!linked?.TxnId) continue
      payments.push({
        externalId: row.Id,
        externalInvoiceId: linked.TxnId,
        amount: (row.TotalAmt ?? 0).toFixed(2),
        paidOn: row.TxnDate ? new Date(row.TxnDate) : null,
        reference: row.PaymentRefNum ?? null,
      })
    }
    return payments
  },

  async refresh(ctx: ConnectorContext) {
    if (!ctx.credential.refreshToken) {
      throw new ConnectorError('This QuickBooks connection has no refresh token.', 'NO_CREDENTIAL')
    }
    const clientId = process.env.QUICKBOOKS_CLIENT_ID
    const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET
    if (!clientId || !clientSecret) {
      throw new ConnectorError('QuickBooks is not configured on this deployment.', 'NO_CREDENTIAL')
    }
    const data = await providerRequest<{ access_token: string; refresh_token?: string; expires_in: number }>(
      'quickbooks.refresh',
      {
        method: 'POST',
        url: TOKEN_URL,
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        data: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: ctx.credential.refreshToken }).toString(),
      },
    )
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    }
  },
}
