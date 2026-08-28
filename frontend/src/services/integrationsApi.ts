// =============================================================
// §8.5 — Integrations, e-signature, SSO and access clients.
//
// Every status shown in the UI comes from the server. Nothing here infers
// "connected" from the presence of a field, because that is exactly the lie
// the backend goes to some trouble to avoid telling.
// =============================================================
import { api } from './api'

export type IntegrationCategory = 'ACCOUNTING' | 'CALENDAR' | 'CHAT' | 'ESIGNATURE'

export type IntegrationStatus =
  | 'NOT_CONFIGURED' | 'CREDENTIAL_REQUIRED' | 'PENDING'
  | 'CONNECTED' | 'ERROR' | 'EXPIRED' | 'DISCONNECTED'

export interface IntegrationConnection {
  id: string
  provider: string
  category: IntegrationCategory
  label: string
  status: IntegrationStatus
  externalAccountName: string | null
  grantedScopes: string[]
  connectedAt: string | null
  lastSyncAt: string | null
  lastSuccessfulSyncAt: string | null
  lastError: string | null
  consecutiveFailures: number
  config: Record<string, unknown>
  /** ADAPTER_IMPLEMENTED or CONTRACT_ONLY. Rendered, not paraphrased. */
  implementation: string
  capabilities: string[]
  /** False when this deployment holds no server-side credential. */
  platformConfigured: boolean
  missingEnv: string[]
  configurationNote: string
}

export interface SignatureRequestRow {
  id: string
  documentType: string
  status: string
  title: string
  provider: string | null
  providerStatus: string | null
  sentAt: string | null
  completedAt: string | null
  declinedAt: string | null
  declineReason: string | null
  lastError: string | null
  fileName: string | null
  createdAt: string
  signers: Array<{ id: string; name: string; email: string; routingOrder: number; status: string; signedAt: string | null }>
}

export interface SsoConfig {
  id: string
  providerType: 'OIDC' | 'SAML'
  displayName: string
  enabled: boolean
  issuer: string | null
  clientId: string | null
  /** Whether one is stored. The secret itself is never returned. */
  clientSecretConfigured: boolean
  authorizationUrl: string | null
  tokenUrl: string | null
  jwksUri: string | null
  allowedEmailDomains: string[]
  enforced: boolean
  breakGlassEmails: string[]
  autoProvision: boolean
  defaultRole: string
  lastLoginAt: string | null
  lastError: string | null
}

export interface AccessUser {
  id: string
  email: string
  firstName: string
  lastName: string
  role: string
  extraPermissions: string[]
  isActive: boolean
  lastLoginAt: string | null
}

export interface RbacCatalog {
  roles: Array<{ role: string; permissions: string[] }>
  permissions: Array<{ permission: string; description: string }>
}

async function get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const res = await api.get(url, { params })
  return res.data.data as T
}
async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await api.post(url, body)
  return res.data.data as T
}
async function put<T>(url: string, body?: unknown): Promise<T> {
  const res = await api.put(url, body)
  return res.data.data as T
}

export const integrationsApi = {
  list: () => get<IntegrationConnection[]>('/integrations'),
  authorize: (provider: string) => post<{ authorizationUrl: string }>(`/integrations/${provider.toLowerCase()}/authorize`, {}),
  connectTeams: (webhookUrl: string, channelName?: string) =>
    post<IntegrationConnection>('/integrations/teams/connect', { webhookUrl, channelName }),
  saveCredentials: (provider: string, body: Record<string, unknown>) =>
    post<IntegrationConnection>(`/integrations/${provider.toLowerCase()}/credentials`, body),
  test: (id: string) => post<IntegrationConnection & { test: { ok: boolean; detail: string } }>(`/integrations/${id}/test`, {}),
  sync: (id: string, body: Record<string, unknown> = {}) => post<Record<string, unknown>>(`/integrations/${id}/sync`, body),
  disconnect: (id: string) => post<IntegrationConnection>(`/integrations/${id}/disconnect`, {}),
  syncRecords: (id: string) => get<Array<Record<string, unknown>>>(`/integrations/${id}/sync-records`),
}

export const esignApi = {
  list: () => get<SignatureRequestRow[]>('/esign'),
  /** Multipart: the document travels with the request so there is one record of it. */
  create: async (fields: Record<string, unknown>, file: File | null) => {
    const form = new FormData()
    Object.entries(fields).forEach(([k, v]) => {
      if (v === null || v === undefined || v === '') return
      form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
    })
    if (file) form.append('file', file)
    const res = await api.post('/esign', form)
    return res.data.data as SignatureRequestRow
  },
  downloadDocument: async (id: string, fileName: string) => {
    const res = await api.get(`/esign/${id}/document`, { responseType: 'blob' })
    const url = URL.createObjectURL(res.data)
    const a = document.createElement('a'); a.href = url; a.download = fileName; a.click()
    URL.revokeObjectURL(url)
  },
  send: (id: string) => post<SignatureRequestRow>(`/esign/${id}/send`, {}),
  void: (id: string, reason: string) => post<SignatureRequestRow>(`/esign/${id}/void`, { reason }),
}

export const ssoApi = {
  config: () => get<SsoConfig | null>('/sso/admin/config'),
  save: (body: Record<string, unknown>) => put<SsoConfig>('/sso/admin/config', body),
  identities: () => get<Array<Record<string, unknown>>>('/sso/admin/identities'),
}

export const rbacApi = {
  catalog: () => get<RbacCatalog>('/rbac/catalog'),
  me: () => get<{ role: string | null; permissions: string[] }>('/rbac/me'),
  users: () => get<AccessUser[]>('/rbac/users'),
  updateUser: (id: string, body: Record<string, unknown>) => put<AccessUser>(`/rbac/users/${id}`, body),
}
