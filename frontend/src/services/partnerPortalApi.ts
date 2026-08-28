// =============================================================
// §8.3 — Partner portal client.
//
// A completely separate token from the internal session. It is kept under its
// own storage key and is never sent to an internal endpoint, so an external
// partner session can never be mistaken for a firm user's.
// =============================================================
import axios from 'axios'

const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001'
const STORAGE_KEY = 'bytescon_partner_auth'

export interface PartnerAuth {
  token: string
  user: { id: string; email: string; firstName: string; lastName: string }
  branding: {
    brandingDisplayName: string | null
    brandingLogoUrl: string | null
    brandingPrimaryColor: string | null
    brandingSecondaryColor: string | null
  } | null
}

export function loadPartnerAuth(): PartnerAuth | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as PartnerAuth) : null
  } catch {
    return null
  }
}

export function savePartnerAuth(auth: PartnerAuth): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(auth))
}

export function clearPartnerAuth(): void {
  localStorage.removeItem(STORAGE_KEY)
}

const client = axios.create({ baseURL: `${API_BASE}/api/partner-portal` })
client.interceptors.request.use((cfg) => {
  const auth = loadPartnerAuth()
  if (auth?.token) cfg.headers.Authorization = `Bearer ${auth.token}`
  return cfg
})

export interface Engagements {
  opportunities: Array<{ id: string; title: string; agency: string | null; solicitationNumber: string | null; responseDeadline: string | null }>
  contracts: Array<{ id: string; contractNumber: string; title: string; agency: string | null; startDate: string | null; endDate: string | null }>
  purchaseOrders: Array<{ id: string; poNumber: string; status: string; ceilingAmount: string; startDate: string | null; endDate: string | null }>
  note: string
}

export type DeliverableSubmissionStatus = 'DRAFT' | 'SUBMITTED' | 'CHANGES_REQUESTED' | 'ACCEPTED_BY_PRIME'

export interface PartnerDeliverable {
  id: string
  name: string
  cdrlNumber: string | null
  description: string | null
  dueDate: string | null
  status: string
}

export interface PartnerDeliverableDetail extends PartnerDeliverable {
  /** The prime's own status. Read-only here — the portal never writes it. */
  primeStatus: string
  submissions: Array<{
    id: string
    status: DeliverableSubmissionStatus
    note: string | null
    fileName: string | null
    fileSize: number | null
    submittedAt: string | null
    reviewedAt: string | null
    reviewNotes: string | null
    createdAt: string
  }>
  note: string
}

export interface PartnerProfile {
  partner: {
    id: string; name: string; uei: string | null; cage: string | null
    website: string | null; geography: string | null
    contactName: string | null; contactEmail: string | null; contactPhone: string | null
    capabilities: string[]; certifications: string[]; primaryNaicsCodes: string[]
  }
  changeRequests: Array<{
    id: string; status: string; proposed: Record<string, unknown>
    submittedNote: string | null; reviewNotes: string | null
    reviewedAt: string | null; appliedAt: string | null; createdAt: string
  }>
  editableFields: string[]
  note: string
}

/** A login that stopped at the second factor. Not a session. */
export interface PartnerMfaChallenge {
  mfaRequired: true
  mfaChallengeToken: string
}

export interface PartnerPoDetail {
  id: string
  poNumber: string
  status: string
  description: string | null
  ceilingAmount: string
  invoicedTotal: string
  remainingBalance: string
  lines: Array<{ id: string; description: string; amount: string; quantity: string | null; unit: string | null; unitPrice: string | null }>
  invoices: Array<{ id: string; invoiceNumber: string; invoiceDate: string; amount: string; status: string; postedByPrime: boolean; paymentRecorded: boolean }>
}

/**
 * Download an authorized file.
 *
 * A blob request rather than a plain link: the endpoint requires the partner
 * bearer token, so an `<a href>` would arrive unauthenticated. Nothing about
 * the URL grants access — the server re-derives the grant on every request.
 */
async function downloadBlob(path: string, fallbackName: string): Promise<void> {
  const res = await client.get(path, { responseType: 'blob' })
  const disposition = String(res.headers['content-disposition'] ?? '')
  const match = /filename="?([^"]+)"?/.exec(disposition)
  const url = URL.createObjectURL(res.data as Blob)
  const link = document.createElement('a')
  link.href = url
  link.download = match?.[1] ?? fallbackName
  link.click()
  URL.revokeObjectURL(url)
}

export const partnerPortalApi = {
  login: async (email: string, password: string): Promise<PartnerAuth | PartnerMfaChallenge> => {
    const res = await client.post('/auth/login', { email, password })
    if (res.data?.code === 'MFA_REQUIRED') {
      return { mfaRequired: true, mfaChallengeToken: res.data.mfaChallengeToken as string }
    }
    return res.data.data as PartnerAuth
  },
  verifyMfa: async (challengeToken: string, code: string): Promise<PartnerAuth> => {
    const res = await client.post('/auth/mfa/verify', { code }, {
      headers: { Authorization: `Bearer ${challengeToken}` },
    })
    return res.data.data as PartnerAuth
  },
  forgotPassword: async (email: string): Promise<{ message: string }> =>
    (await client.post('/auth/forgot-password', { email })).data.data,
  resetPassword: async (token: string, password: string) =>
    (await client.post('/auth/reset-password', { token, password })).data.data,
  acceptInvite: async (token: string, password: string) => {
    const res = await client.post('/auth/accept-invite', { token, password })
    return res.data.data
  },
  me: async () => (await client.get('/me')).data.data,
  engagements: async (): Promise<Engagements> => (await client.get('/engagements')).data.data,
  purchaseOrder: async (id: string): Promise<PartnerPoDetail> => (await client.get(`/purchase-orders/${id}`)).data.data,
  flowDowns: async (poId: string) => (await client.get(`/purchase-orders/${poId}/flow-downs`)).data.data,
  acknowledgeFlowDown: async (id: string) => (await client.post(`/flow-downs/${id}/acknowledge`, {})).data.data,
  deliverables: async () => (await client.get('/deliverables')).data.data,
  invoices: async () => (await client.get('/invoices')).data.data,
  submitInvoice: async (body: Record<string, unknown>) => (await client.post('/invoices', body)).data.data,
  documents: async () => (await client.get('/documents')).data.data,
  uploadDocument: async (fields: { scopeType: string; scopeId: string; category: string; title: string; notes?: string }, file: File) => {
    const form = new FormData()
    Object.entries(fields).forEach(([k, v]) => { if (v) form.append(k, v) })
    form.append('file', file)
    return (await client.post('/documents', form)).data.data
  },
  downloadDocument: (id: string, fileName: string) => downloadBlob(`/documents/${id}/download`, fileName),
  contributePersonnel: async (body: Record<string, unknown>) => (await client.post('/personnel-contributions', body)).data.data,

  deliverable: async (id: string): Promise<PartnerDeliverableDetail> =>
    (await client.get(`/deliverables/${id}`)).data.data,
  saveDeliverableDraft: async (deliverableId: string, note: string, file: File | null) => {
    const form = new FormData()
    form.append('note', note)
    if (file) form.append('file', file)
    return (await client.post(`/deliverables/${deliverableId}/submissions`, form)).data.data
  },
  submitDeliverable: async (submissionId: string) =>
    (await client.post(`/deliverable-submissions/${submissionId}/submit`, {})).data.data,
  downloadSubmission: (id: string, fileName: string) =>
    downloadBlob(`/deliverable-submissions/${id}/download`, fileName),

  profile: async (): Promise<PartnerProfile> => (await client.get('/profile')).data.data,
  proposeProfileChange: async (proposed: Record<string, unknown>, submittedNote?: string) =>
    (await client.post('/profile/change-requests', { proposed, submittedNote })).data.data,

  mfaStatus: async (): Promise<{ enabled: boolean; enrolledAt: string | null }> =>
    (await client.get('/mfa/status')).data.data,
  mfaEnroll: async (): Promise<{ secret: string; otpauthUri: string }> =>
    (await client.post('/mfa/enroll', {})).data.data,
  mfaConfirm: async (code: string): Promise<{ enabled: boolean; recoveryCodes: string[]; note: string }> =>
    (await client.post('/mfa/enroll/verify', { code })).data.data,
  mfaDisable: async (code: string) => (await client.post('/mfa/disable', { code })).data.data,
}
