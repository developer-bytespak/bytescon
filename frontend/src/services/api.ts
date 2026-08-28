import axios from 'axios';
import { trackEvent } from '../lib/analytics';

const API_BASE =
  import.meta.env.VITE_API_URL || 'http://localhost:3001';

export const api = axios.create({
  baseURL: `${API_BASE}/api`,
  headers: { 'Content-Type': 'application/json' },
  timeout: 30000, // 30s – prevents indefinitely hanging requests
  withCredentials: true, // send the http-only session cookie on every call
});

// Bare axios calls (used across several components) must also carry the cookie.
axios.defaults.withCredentials = true;

// Attach the stored JWT on every request — UNLESS the caller already set an
// explicit Authorization header (the scoped-token flows: completeAgreements and
// mfa/verify pass the gate/challenge token themselves and must not be clobbered
// by a stale stored session token).
api.interceptors.request.use((config) => {
  try {
    if (config.headers.Authorization) return config;
    const stored = localStorage.getItem('bytescon_auth');
    if (stored) {
      const auth = JSON.parse(stored);
      if (auth.token) {
        config.headers.Authorization = `Bearer ${auth.token}`;
      }
    }
  } catch {
    /* corrupt auth storage — proceed unauthenticated; the 401 handler recovers */
  }
  return config;
});

// Suppress the literal "Invalid token" / "Token expired" strings on every 401
// so components that catch the rejection don't briefly render them. Run on
// both the configured `api` instance AND the default axios instance, since
// many components use bare axios.get / axios.post.
function suppressAuthErrorMessage(err: any) {
  if (err.response?.status !== 401) return
  if (err.response?.data && typeof err.response.data === 'object') {
    err.response.data.error = ''
    err.response.data.message = ''
  }
}

// On the CONFIGURED api instance only: also clear auth and redirect. This
// instance is exclusively used for our own authenticated API calls, so a
// 401 here is unambiguously "the consultant's token is dead."
api.interceptors.response.use(
  (res) => res,
  (err) => {
    suppressAuthErrorMessage(err)
    // Paywall rejections from gated endpoints: broadcast a window event so a
    // global listener (paywall modal) can react, but still reject so callers
    // handle the failure locally too. No redirect here.
    const status = err.response?.status
    const body = err.response?.data
    if (
      (status === 402 && body?.code === 'PLAN_REQUIRED') ||
      (status === 403 && body?.code === 'ADDON_REQUIRED')
    ) {
      window.dispatchEvent(new CustomEvent('mrgc:paywall', {
        detail: {
          code: body.code,
          addon: body.addon,
          addonName: body.addonName,
          addonPriceMonthly: body.addonPriceMonthly,
          error: body.error,
        },
      }))
    }
    if (err.response?.status === 401) {
      localStorage.removeItem('bytescon_auth')
      const currentPath = window.location.pathname
      // /mfa-challenge must be here: a mistyped TOTP code returns 401, and
      // redirecting would discard the challenge token — forcing a full
      // re-login for every typo instead of showing "Invalid code".
      const publicPaths = ['/login', '/welcome', '/register', '/forgot-password', '/reset-password', '/client-login', '/mfa-challenge']
      if (!publicPaths.some((p) => currentPath.startsWith(p))) {
        window.location.replace('/login')
      }
    }
    return Promise.reject(err);
  }
);

// On the DEFAULT axios instance: only suppress the message, never clear auth
// or redirect. Bare axios calls go to a mix of public endpoints, client-portal
// endpoints, and (rarely) third-party APIs — a 401 from any of them must not
// kick a logged-in consultant out of an unrelated page.
axios.interceptors.response.use(
  (res) => res,
  (err) => {
    suppressAuthErrorMessage(err)
    return Promise.reject(err);
  }
);

// ---- Auth ----
export const authApi = {
  // §8.5 — single sign-on discovery and start. Public: neither call needs a
  // session, and neither reveals whether an address has an account.
  discoverSso: (email: string) => api.get('/sso/discover', { params: { email } }).then((r) => r.data),
  startSso: (consultingFirmId: string, returnTo?: string) =>
    api.post('/sso/start', { consultingFirmId, returnTo }).then((r) => r.data),

  login: (email: string, password: string) =>
    api.post('/auth/login', { email, password }).then((r) => r.data),
  registerFirm: (data: any) =>
    api.post('/auth/register-firm', data).then((r) => {
      trackEvent('signup_completed');
      return r.data;
    }),
  // Admin-only: add a read-only team member (CONSULTANT) directly (sets a temp password).
  registerUser: (data: { firstName: string; lastName: string; email: string; password: string }) =>
    api.post('/auth/register-user', { ...data, role: 'CONSULTANT' }).then((r) => r.data),
  // Admin-only: email-invite a read-only team member; they set their own password from the link.
  inviteUser: (data: { firstName: string; lastName: string; email: string }) =>
    api.post('/auth/invite-user', data).then((r) => r.data),
  profile: () => api.get('/auth/profile').then((r) => r.data),
  betaStatus: () =>
    api.get('/auth/beta-status').then((r) => r.data),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.put('/auth/change-password', { currentPassword, newPassword }).then((r) => r.data),
  forgotPassword: (email: string) =>
    api.post('/auth/forgot-password', { email }).then((r) => r.data),
  resetPassword: (token: string, newPassword: string) =>
    api.post('/auth/reset-password', { token, newPassword }).then((r) => r.data),
  // Legal + verification flow
  legalCurrent: () => api.get('/auth/legal/current').then((r) => r.data),
  verifyEmail: (token: string) =>
    api.post('/auth/verify-email', { token }).then((r) => r.data),
  resendVerification: (email: string) =>
    api.post('/auth/resend-verification', { email }).then((r) => r.data),
  acceptAgreements: (acceptedTosVersion: string) =>
    api.post('/auth/accept-agreements', { acceptedTosVersion }).then((r) => r.data),
  // Login gate-2: caller passes the scoped completionToken explicitly. On
  // success returns a full session ({ token, user, firm }).
  completeAgreements: (acceptedTosVersion: string, completionToken: string) =>
    api.post('/auth/complete-agreements',
      { acceptedTosVersion },
      { headers: { Authorization: `Bearer ${completionToken}` } }
    ).then((r) => r.data),
  // MFA (TOTP). mfaVerify exchanges the scoped challenge token + code for a full session.
  mfaVerify: (mfaChallengeToken: string, code: string) =>
    api.post('/auth/mfa/verify', { code }, { headers: { Authorization: `Bearer ${mfaChallengeToken}` } }).then((r) => r.data),
  mfaStatus: () => api.get('/auth/mfa/status').then((r) => r.data),
  mfaEnroll: () => api.post('/auth/mfa/enroll').then((r) => r.data),
  mfaEnrollVerify: (code: string) => api.post('/auth/mfa/enroll/verify', { code }).then((r) => r.data),
  mfaDisable: (code: string) => api.post('/auth/mfa/disable', { code }).then((r) => r.data),
};

// ---- Opportunities ----
export const opportunitiesApi = {
  search: (params?: any) =>
    api.get('/opportunities', { params }).then((r) => r.data),
  /** §5.1 Stage 3 — resolved win probability + calibration labelling. */
  winProbability: (id: string) =>
    api.get(`/opportunities/${id}/win-probability`).then((r) => r.data),
  /** Full filtered pipeline (no pagination, capped) for CSV export. */
  exportPipeline: (params?: any) =>
    api.get('/opportunities/export', { params }).then((r) => r.data),
  getById: (id: string) =>
    api.get(`/opportunities/${id}`).then((r) => r.data),
  ingest: (params: any) =>
    api.post('/opportunities/ingest', params).then((r) => r.data),
  score: (id: string, clientCompanyId: string) =>
    api.post(`/opportunities/${id}/score`, { clientCompanyId }).then((r) => r.data),
};

// ---- Jobs ----
export const jobsApi = {
  triggerIngest: (params?: { naicsCode?: string; agency?: string; limit?: number }) =>
    api.post('/jobs/ingest', params || {}).then((r) => r.data),
  triggerEnrich: () =>
    api.post('/jobs/enrich', {}).then((r) => r.data),
  triggerDocumentAnalysis: (documentId: string) =>
    api.post(`/jobs/analyze/${documentId}`).then((r) => r.data),
  getJob: (id: string) =>
    api.get(`/jobs/${id}`).then((r) => r.data),
  listJobs: () =>
    api.get('/jobs').then((r) => r.data),
};

// ---- Documents ----
export const documentsApi = {
  upload: (opportunityId: string, file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('opportunityId', opportunityId);
    return api.post('/documents/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data);
  },
  uploadZip: (opportunityId: string, file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('opportunityId', opportunityId);
    return api.post('/documents/upload-zip', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data);
  },
  list: (opportunityId: string) =>
    api.get(`/documents/${opportunityId}`).then((r) => r.data),
  delete: (documentId: string) =>
    api.delete(`/documents/${documentId}`).then((r) => r.data),
};

// ---- Clients ----
export const clientsApi = {
  list: (params?: any) =>
    api.get('/clients', { params }).then((r) => r.data),
  getById: (id: string) =>
    api.get(`/clients/${id}`).then((r) => r.data),
  create: (data: any) =>
    api.post('/clients', data).then((r) => r.data),
  update: (id: string, data: any) =>
    api.put(`/clients/${id}`, data).then((r) => r.data),
  updateNotes: (id: string, notes: string | null, updatedAt?: string) =>
    api.patch(`/clients/${id}/notes`, { notes, updatedAt }).then((r) => r.data),
  archive: (id: string) =>
    api.patch(`/clients/${id}/archive`).then((r) => r.data),
  restore: (id: string) =>
    api.patch(`/clients/${id}/restore`).then((r) => r.data),
  stats: (id: string) =>
    api.get(`/clients/${id}/stats`).then((r) => r.data),
  /** Look up entity data from SAM.gov without creating a client record */
  samLookup: (params: { uei?: string; cage?: string; name?: string }) =>
    api.get('/clients/lookup', { params }).then((r) => r.data),
  /** Bulk import clients from a CSV file */
  importCsv: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return api.post('/clients/import-csv', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60000,
    }).then((r) => r.data);
  },
  searchNaics: (q: string) =>
    api.get('/clients/naics/search', { params: { q } }).then((r) => r.data),
  /** Update per-client branding fields (ADMIN only). */
  updateBranding: (id: string, data: {
    displayName?: string | null
    tagline?: string | null
    logoUrl?: string | null
    primaryColor?: string | null
    secondaryColor?: string | null
    footerAddress?: string | null
    preparedByLine?: string | null
  }) =>
    api.put(`/clients/${id}/branding`, data).then((r) => r.data),
  /** Upload a logo image (PNG/JPEG/SVG/WebP, ≤2MB) and bind it to the client. */
  uploadLogo: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return api.post(`/clients/${id}/branding/upload-logo`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60000,
    }).then((r) => r.data);
  },
};

// ---- Submissions ----
export type SubmissionOutcome = 'WON' | 'LOST' | 'NO_AWARD' | 'WITHDRAWN';
export const submissionsApi = {
  list: (params?: any) =>
    api.get('/submissions', { params }).then((r) => r.data),
  create: (data: any) =>
    api.post('/submissions', data).then((r) => r.data),
  getById: (id: string) =>
    api.get(`/submissions/${id}`).then((r) => r.data),
  recordOutcome: (id: string, outcome: SubmissionOutcome, notes?: string) =>
    api.patch(`/submissions/${id}/outcome`, { outcome, notes }).then((r) => r.data),
  // FIX-1 flywheel: pursued bids past their deadline still awaiting a WON/LOST
  // outcome, plus the capture-rate gauge.
  pendingOutcomes: () =>
    api.get('/submissions/pending-outcomes').then((r) => r.data),
};

// ---- Penalties ----
export const penaltiesApi = {
  list: (params?: any) =>
    api.get('/penalties', { params }).then((r) => r.data),
  summary: () =>
    api.get('/penalties/summary').then((r) => r.data),
  getById: (id: string) =>
    api.get(`/penalties/${id}`).then((r) => r.data),
  markPaid: (id: string) =>
    api.put(`/penalties/${id}/pay`).then((r) => r.data),
};

// ---- Firm ----
export const firmApi = {
  get: () =>
    api.get('/firm').then((r) => r.data),
  // FIX-6: fleet-wide gross margin per tenant (platform admin only).
  platformCogsMargin: (days = 30) =>
    api.get('/firm/platform/cogs-margin', { params: { days } }).then((r) => r.data),
  // Operator "prove-it" metrics (platform admin only).
  platformMetrics: () => api.get('/firm/platform/metrics').then((r) => r.data),
  // FIX-5: activation funnel + retention cohorts + north-star (platform admin only).
  platformFunnel: () => api.get('/firm/platform/funnel').then((r) => r.data),
  // FIX-3: download this firm's audit trail as CSV (ADMIN).
  exportAuditLog: async (days = 90) => {
    const res = await api.get('/firm/audit-log/export', { params: { days }, responseType: 'blob' })
    const url = URL.createObjectURL(res.data)
    const a = document.createElement('a')
    a.href = url
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  },
  dashboard: () =>
    api.get('/firm/dashboard').then((r) => r.data),
  metrics: () =>
    api.get('/firm/metrics').then((r) => r.data),
  updatePenaltyConfig: (data: any) =>
    api.put('/firm/penalty-config', data).then((r) => r.data),
  users: () =>
    api.get('/firm/users').then((r) => r.data),
  seedDemo: () =>
    api.post('/firm/seed-demo').then((r) => r.data),
  updateSamApiKey: (samApiKey: string) =>
    api.put('/firm/sam-api-key', { samApiKey }).then((r) => r.data),
  testSamKey: (samApiKey: string) =>
    api.post('/firm/test-sam-key', { samApiKey }).then((r) => r.data),
  updateAnthropicApiKey: (anthropicApiKey: string) =>
    api.put('/firm/anthropic-api-key', { anthropicApiKey }).then((r) => r.data),
  updateLlmProvider: (llmProvider: string) =>
    api.put('/firm/llm-provider', { llmProvider }).then((r) => r.data),
  updateOpenaiApiKey: (openaiApiKey: string) =>
    api.put('/firm/openai-api-key', { openaiApiKey }).then((r) => r.data),
  updateInsightEngineApiKey: (insightEngineApiKey: string) =>
    api.put('/firm/insight-engine-api-key', { insightEngineApiKey }).then((r) => r.data),
  updateLocalaiConfig: (data: { localaiBaseUrl?: string; localaiModel?: string }) =>
    api.put('/firm/localai-config', data).then((r) => r.data),
  aiUsage: (params?: { days?: number }) =>
    api.get('/firm/ai-usage', { params }).then((r) => r.data),
  updateVeteranStatus: (isVeteranOwned: boolean) =>
    api.put('/firm/veteran-status', { isVeteranOwned }).then((r) => r.data),
};

// ---- Analytics ----
export const analyticsApi = {
  trends: (params?: { months?: number }) =>
    api.get('/analytics/trends', { params }).then((r) => r.data),
  pipeline: () =>
    api.get('/analytics/pipeline').then((r) => r.data),
  marketIntelligence: () =>
    api.get('/analytics/market-intelligence').then((r) => r.data),
  predictions: () =>
    api.get('/analytics/predictions').then((r) => r.data),
  portfolioHealth: () =>
    api.get('/analytics/portfolio-health').then((r) => r.data),
  complianceLogs: (params?: { entityType?: string; entityId?: string; from?: string; to?: string; page?: number; limit?: number }) =>
    api.get('/analytics/compliance-logs', { params }).then((r) => r.data),
  pipelineAnalysis: () =>
    api.get('/analytics/pipeline-analysis').then((r) => r.data),
};

// ---- Decisions ----
export const decisionsApi = {
  list: (params?: any) =>
    api.get('/decision', { params }).then((r) => r.data),
  run: (opportunityId: string, clientCompanyId: string) =>
    api.post('/decision/run', { opportunityId, clientCompanyId }).then((r) => {
      trackEvent('bid_decision_made', {
        opportunityId,
        recommendation: r.data?.data?.recommendation,
      });
      return r.data;
    }),
  metrics: () =>
    api.get('/decision/metrics').then((r) => r.data),
  queue: (limit?: number) =>
    api.get('/decision/queue', { params: limit ? { limit } : {} }).then((r) => r.data),
  resolve: (id: string, decision: 'GO' | 'NO_GO', note?: string) =>
    api.patch(`/decision/${id}/decision`, { decision, note }).then((r) => {
      trackEvent('bid_decision_resolved', { decisionId: id, decision });
      return r.data;
    }),
};

// ---- Doc Requirements ----
export const docRequirementsApi = {
  list: (params?: any) =>
    api.get('/doc-requirements', { params }).then((r) => r.data),
  create: (data: any) =>
    api.post('/doc-requirements', data).then((r) => r.data),
  update: (id: string, data: any) =>
    api.put(`/doc-requirements/${id}`, data).then((r) => r.data),
  delete: (id: string) =>
    api.delete(`/doc-requirements/${id}`).then((r) => r.data),
  forClient: (clientId: string) =>
    api.get(`/doc-requirements/client/${clientId}`).then((r) => r.data),
};

// ---- Templates ----
export const templatesApi = {
  list: (params?: any) =>
    api.get('/templates', { params }).then((r) => r.data),
  upload: (formData: FormData) =>
    api.post('/templates', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data),
  update: (id: string, data: any) =>
    api.patch(`/templates/${id}`, data).then((r) => r.data),
  deactivate: (id: string) =>
    api.delete(`/templates/${id}`).then((r) => r.data),
  assign: (id: string, data: any) =>
    api.post(`/templates/${id}/assign`, data).then((r) => r.data),
  download: async (id: string) => {
    const response = await api.get(`/templates/${id}/download`, { responseType: 'blob' });
    return response.data as Blob;
  },
};

// ---- Rewards ----
export const rewardsApi = {
  list: (params?: any) =>
    api.get('/rewards', { params }).then((r) => r.data),
  create: (data: any) =>
    api.post('/rewards', data).then((r) => r.data),
  evaluate: (clientCompanyId: string) =>
    api.post(`/rewards/evaluate/${clientCompanyId}`).then((r) => r.data),
  redeem: (id: string) =>
    api.put(`/rewards/${id}/redeem`).then((r) => r.data),
};

// ---- Score / Amendment ----
export const scoreApi = {
  getBreakdown: (opportunityId: string) =>
    api.get(`/opportunities/${opportunityId}/score-breakdown`).then((r) => r.data),
  interpretAmendment: (opportunityId: string, amendmentId: string) =>
    api.post(`/opportunities/${opportunityId}/amendments/${amendmentId}/interpret`).then((r) => r.data),
};

// ---- Clients — decline/un-decline per client ----
export const clientOpportunitiesApi = {
  getMatched: (clientId: string) =>
    api.get(`/clients/${clientId}/opportunities`).then((r) => r.data),
  decline: (clientId: string, opportunityId: string, reason?: string) =>
    api.post(`/clients/${clientId}/decline-opportunity`, { opportunityId, reason }).then((r) => r.data),
  undecline: (clientId: string, opportunityId: string) =>
    api.delete(`/clients/${clientId}/decline-opportunity/${opportunityId}`).then((r) => r.data),
};

// ---- Client Portal Users (created by consultants) ----
export const clientPortalUsersApi = {
  register: (data: { clientCompanyId: string; email: string; password: string; firstName: string; lastName: string }) =>
    api.post('/client-portal/auth/register', data).then((r) => r.data),
  /** List all portal users for a client */
  listByClient: (clientId: string) =>
    api.get(`/client-portal/admin/users/${clientId}`).then((r) => r.data),
  /** Reset a portal user's password */
  resetPassword: (userId: string, newPassword: string) =>
    api.put(`/client-portal/admin/users/${userId}/reset-password`, { newPassword }).then((r) => r.data),
  /** Toggle a portal user's active status */
  toggleActive: (userId: string) =>
    api.put(`/client-portal/admin/users/${userId}/toggle-active`).then((r) => r.data),
};

// ---- Client Portal (used from portal frontend with portal token) ----
const API_BASE_RAW = import.meta.env.VITE_API_URL || 'http://localhost:3001';
export const clientPortalApi = {
  _getToken: () => { try { const raw = localStorage.getItem('bytescon_client_auth'); return raw ? (JSON.parse(raw).token ?? '') : '' } catch { return '' } },
  getOpportunities: () =>
    axios.get(`${API_BASE_RAW}/api/client-portal/opportunities`, { headers: { Authorization: `Bearer ${clientPortalApi._getToken()}` } }).then(r => r.data),
  uploadDoc: (file: File, title: string, notes?: string) => {
    const fd = new FormData(); fd.append('file', file); fd.append('title', title); if (notes) fd.append('notes', notes);
    return axios.post(`${API_BASE_RAW}/api/client-portal/uploads`, fd, { headers: { Authorization: `Bearer ${clientPortalApi._getToken()}`, 'Content-Type': 'multipart/form-data' } }).then(r => r.data);
  },
  getUploads: () =>
    axios.get(`${API_BASE_RAW}/api/client-portal/uploads`, { headers: { Authorization: `Bearer ${clientPortalApi._getToken()}` } }).then(r => r.data),
  adminGetUploads: (clientId: string) =>
    api.get(`/client-portal/admin/uploads/${clientId}`).then(r => r.data),
  adminDownloadUpload: async (clientId: string, uploadId: string, fileName: string) => {
    const res = await api.get(`/client-portal/admin/uploads/${clientId}/download/${uploadId}`, { responseType: 'blob' });
    const url = URL.createObjectURL(res.data); const a = document.createElement('a'); a.href = url; a.download = fileName; a.click(); URL.revokeObjectURL(url);
  },
};

// ---- Client Documents & Template Library ----
export const clientDocumentsApi = {
  upload: (data: { clientCompanyId: string; documentType: string; title: string; notes?: string }, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    Object.entries(data).forEach(([k, v]) => { if (v !== undefined) fd.append(k, v) })
    return api.post('/client-documents/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } }).then((r) => r.data)
  },
  list: (clientCompanyId: string) =>
    api.get('/client-documents', { params: { clientCompanyId } }).then((r) => r.data),
  download: async (documentId: string, fileName: string) => {
    const res = await api.get(`/client-documents/${documentId}/download`, { responseType: 'blob' })
    const url = URL.createObjectURL(res.data)
    const a = document.createElement('a'); a.href = url; a.download = fileName; a.click()
    URL.revokeObjectURL(url)
  },
  delete: (documentId: string) =>
    api.delete('/client-documents/' + documentId).then((r) => r.data),
  shareAsTemplate: (documentId: string, data: { title: string; description?: string }) =>
    api.post('/client-documents/' + documentId + '/share-as-template', data).then((r) => r.data),
  listTemplates: (params?: { documentType?: string; page?: number; limit?: number }) =>
    api.get('/client-documents/templates', { params }).then((r) => r.data),
  downloadTemplate: async (templateId: string, fileName: string) => {
    const res = await api.get('/client-documents/templates/download/' + templateId, { responseType: 'blob' })
    // Guard: if the blob is tiny or JSON (error response), don't download blank file
    const blob: Blob = res.data
    if (blob.size < 10) {
      const text = await blob.text()
      throw new Error(text || 'Downloaded file is empty — the template file may be missing from the server.')
    }
    if (blob.type === 'application/json') {
      const text = await blob.text()
      const err = JSON.parse(text)
      throw new Error(err.error || 'Download failed')
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = fileName; a.click()
    URL.revokeObjectURL(url)
  },
  listTemplatesAdmin: () =>
    api.get('/client-documents/templates/admin').then((r) => r.data),
  // Platform-admin cross-tenant moderation (C5)
  canModerateTemplates: () =>
    api.get('/client-documents/templates/admin/can-moderate').then((r) => r.data),
  pendingTemplates: () =>
    api.get('/client-documents/templates/admin/pending').then((r) => r.data),
  previewTemplate: async (templateId: string, fileName: string) => {
    const res = await api.get('/client-documents/templates/admin/' + templateId + '/file', { responseType: 'blob' })
    const blob: Blob = res.data
    if (blob.size < 10) throw new Error('Template file is empty or missing on the server.')
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = fileName; a.click()
    URL.revokeObjectURL(url)
  },
  reviewTemplate: (templateId: string, data: { status: 'APPROVED' | 'REJECTED'; reviewNotes?: string; deidentificationConfirmed?: boolean }) =>
    api.post('/client-documents/templates/' + templateId + '/review', data).then((r) => r.data),
}

// ---- Past Performance ----
export type PastPerformanceContractType = 'FFP' | 'T_AND_M' | 'IDIQ' | 'COST_REIMB' | 'BPA';
export type CparsRating = 'EXCEPTIONAL' | 'VERY_GOOD' | 'SATISFACTORY' | 'MARGINAL' | 'UNSATISFACTORY';

export interface PastPerformanceRecord {
  id: string;
  clientCompanyId: string | null;
  contractNumber: string;
  customerName: string;
  customerAgency: string | null;
  customerPocName: string | null;
  customerPocEmail: string | null;
  customerPocPhone: string | null;
  contractType: PastPerformanceContractType | null;
  totalValue: string | null;
  periodOfPerformanceStart: string | null;
  periodOfPerformanceEnd: string | null;
  cparsRating: CparsRating | null;
  cparsLink: string | null;
  scopeSummary: string;
  relevanceTags: string[];
  isCurrent: boolean;
  sourceSubmissionRecordId: string | null;
  clientCompany?: { id: string; name: string } | null;
}

export interface PastPerformanceCreateInput {
  clientCompanyId?: string | null;
  contractNumber: string;
  customerName: string;
  customerAgency?: string | null;
  customerPocName?: string | null;
  customerPocEmail?: string | null;
  customerPocPhone?: string | null;
  contractType?: PastPerformanceContractType | null;
  totalValue?: number | null;
  periodOfPerformanceStart?: string | null;
  periodOfPerformanceEnd?: string | null;
  cparsRating?: CparsRating | null;
  cparsLink?: string | null;
  scopeSummary?: string;
  relevanceTags?: string[];
  isCurrent?: boolean;
}

export type PastPerformanceUpdateInput = Partial<PastPerformanceCreateInput>;

export const pastPerformanceApi = {
  list: (params?: { clientCompanyId?: string; isCurrent?: boolean }) =>
    api.get('/past-performance', { params }).then((r) => r.data),
  get: (id: string) =>
    api.get('/past-performance/' + id).then((r) => r.data),
  create: (payload: PastPerformanceCreateInput) =>
    api.post('/past-performance', payload).then((r) => r.data),
  update: (id: string, payload: PastPerformanceUpdateInput) =>
    api.patch('/past-performance/' + id, payload).then((r) => r.data),
  remove: (id: string) =>
    api.delete('/past-performance/' + id).then((r) => r.data),
}

// ---- Registration / Certification / Insurance (Section 5 Module 2) ----
export const registrationApi = {
  health: () => api.get('/registration/health').then((r) => r.data),
  getProfile: () => api.get('/registration/profile').then((r) => r.data),
  saveProfile: (payload: Record<string, unknown>) => api.put('/registration/profile', payload).then((r) => r.data),
  listCertifications: (includeArchived = false) => api.get('/registration/certifications', { params: includeArchived ? { includeArchived: true } : {} }).then((r) => r.data),
  createCertification: (payload: Record<string, unknown>) => api.post('/registration/certifications', payload).then((r) => r.data),
  updateCertification: (id: string, payload: Record<string, unknown>) => api.put('/registration/certifications/' + id, payload).then((r) => r.data),
  archiveCertification: (id: string) => api.delete('/registration/certifications/' + id).then((r) => r.data),
  restoreCertification: (id: string) => api.patch('/registration/certifications/' + id + '/restore').then((r) => r.data),
  listInsurance: (includeArchived = false) => api.get('/registration/insurance', { params: includeArchived ? { includeArchived: true } : {} }).then((r) => r.data),
  createInsurance: (payload: Record<string, unknown>) => api.post('/registration/insurance', payload).then((r) => r.data),
  updateInsurance: (id: string, payload: Record<string, unknown>) => api.put('/registration/insurance/' + id, payload).then((r) => r.data),
  archiveInsurance: (id: string) => api.delete('/registration/insurance/' + id).then((r) => r.data),
  restoreInsurance: (id: string) => api.patch('/registration/insurance/' + id + '/restore').then((r) => r.data),
}

// ---- Post-Award Contract Management (Section 5 Module 8) ----
const CM = '/contract-management'
export const contractMgmtApi = {
  list: (params?: Record<string, unknown>) => api.get(CM, { params }).then((r) => r.data),
  get: (id: string) => api.get(`${CM}/${id}`).then((r) => r.data),
  create: (payload: Record<string, unknown>) => api.post(CM, payload).then((r) => r.data),
  createFromOpportunity: (opportunityId: string, payload: Record<string, unknown> = {}) => api.post(`${CM}/from-opportunity/${opportunityId}`, payload).then((r) => r.data),
  update: (id: string, payload: Record<string, unknown>) => api.patch(`${CM}/${id}`, payload).then((r) => r.data),
  archive: (id: string) => api.post(`${CM}/${id}/archive`).then((r) => r.data),
  restore: (id: string) => api.post(`${CM}/${id}/restore`).then((r) => r.data),
  // CLINs
  listClins: (id: string) => api.get(`${CM}/${id}/clins`).then((r) => r.data),
  createClin: (id: string, payload: Record<string, unknown>) => api.post(`${CM}/${id}/clins`, payload).then((r) => r.data),
  updateClin: (clinId: string, payload: Record<string, unknown>) => api.put(`${CM}/clins/${clinId}`, payload).then((r) => r.data),
  archiveClin: (clinId: string) => api.post(`${CM}/clins/${clinId}/archive`).then((r) => r.data),
  // Option periods
  createOption: (id: string, payload: Record<string, unknown>) => api.post(`${CM}/${id}/options`, payload).then((r) => r.data),
  updateOption: (optionId: string, payload: Record<string, unknown>) => api.put(`${CM}/options/${optionId}`, payload).then((r) => r.data),
  // Modifications
  createModification: (id: string, payload: Record<string, unknown>) => api.post(`${CM}/${id}/modifications`, payload).then((r) => r.data),
  applyModification: (modId: string) => api.post(`${CM}/modifications/${modId}/apply`).then((r) => r.data),
  voidModification: (modId: string) => api.post(`${CM}/modifications/${modId}/void`).then((r) => r.data),
  // Deliverables
  createDeliverable: (id: string, payload: Record<string, unknown>) => api.post(`${CM}/${id}/deliverables`, payload).then((r) => r.data),
  updateDeliverable: (delId: string, payload: Record<string, unknown>) => api.put(`${CM}/deliverables/${delId}`, payload).then((r) => r.data),
  submitDeliverable: (delId: string, payload: Record<string, unknown> = {}) => api.post(`${CM}/deliverables/${delId}/submit`, payload).then((r) => r.data),
  acceptDeliverable: (delId: string) => api.post(`${CM}/deliverables/${delId}/accept`).then((r) => r.data),
  rejectDeliverable: (delId: string, reason: string) => api.post(`${CM}/deliverables/${delId}/reject`, { reason }).then((r) => r.data),
  archiveDeliverable: (delId: string) => api.post(`${CM}/deliverables/${delId}/archive`).then((r) => r.data),
  upcomingDeliverables: (windowDays = 14) => api.get(`${CM}/deliverables/upcoming`, { params: { windowDays } }).then((r) => r.data),
  overdueDeliverables: () => api.get(`${CM}/deliverables/overdue`).then((r) => r.data),
}

// ---- Opportunity Pipeline Tracker (Section 5.2) ----
const PURSUITS = '/pursuits'
export const pipelineApi = {
  list: (params?: Record<string, unknown>) => api.get(`${PURSUITS}/pipeline`, { params }).then((r) => r.data),
  setStage: (id: string, stage: string, reason?: string) => api.patch(`${PURSUITS}/${id}/stage`, { stage, reason }).then((r) => r.data),
  assign: (id: string, ownerUserId: string | null) => api.patch(`${PURSUITS}/${id}/assign`, { ownerUserId }).then((r) => r.data),
  setNextAction: (id: string, payload: Record<string, unknown>) => api.patch(`${PURSUITS}/${id}/next-action`, payload).then((r) => r.data),
  close: (id: string, reason: string, note?: string) => api.patch(`${PURSUITS}/${id}/close`, { reason, note }).then((r) => r.data),
  reopen: (id: string) => api.patch(`${PURSUITS}/${id}/reopen`).then((r) => r.data),
}

// ---- Bid Qualification / Scorecard (Section 5.2) ----
const QUAL = '/qualification'
export const qualificationApi = {
  getConfig: () => api.get(`${QUAL}/criteria/config`).then((r) => r.data),
  saveConfig: (criteria: unknown[]) => api.put(`${QUAL}/criteria/config`, { criteria }).then((r) => r.data),
  get: (pursuitId: string) => api.get(`${QUAL}/${pursuitId}`).then((r) => r.data),
  start: (pursuitId: string) => api.post(`${QUAL}/${pursuitId}/start`).then((r) => r.data),
  score: (pursuitId: string, key: string, payload: Record<string, unknown>) => api.patch(`${QUAL}/${pursuitId}/criteria/${key}`, payload).then((r) => r.data),
  saveScorecard: (pursuitId: string, scores: { key: string; score: number | null; evidence?: string | null }[]) => api.patch(`${QUAL}/${pursuitId}/criteria`, { scores }).then((r) => r.data),
  resetScorecard: (pursuitId: string) => api.post(`${QUAL}/${pursuitId}/reset`).then((r) => r.data),
  submitReview: (pursuitId: string, payload: Record<string, unknown>) => api.post(`${QUAL}/${pursuitId}/submit-review`, payload).then((r) => r.data),
  decide: (pursuitId: string, payload: Record<string, unknown>) => api.post(`${QUAL}/${pursuitId}/decision`, payload).then((r) => r.data),
  reassess: (pursuitId: string, reason?: string) => api.post(`${QUAL}/${pursuitId}/reassess`, { reason }).then((r) => r.data),
  history: (pursuitId: string, params?: Record<string, unknown>) => api.get(`${QUAL}/${pursuitId}/history`, { params }).then((r) => r.data),
}

// ---- Gate Reviews (Section 5.2) ----
const GATE = '/gate-reviews'
export const gateReviewsApi = {
  listForPursuit: (pursuitId: string, includeArchived = false) => api.get(`${GATE}/pursuit/${pursuitId}`, { params: includeArchived ? { includeArchived: true } : {} }).then((r) => r.data),
  archive: (id: string) => api.post(`${GATE}/${id}/archive`).then((r) => r.data),
  restore: (id: string) => api.post(`${GATE}/${id}/restore`).then((r) => r.data),
  list: (params?: Record<string, unknown>) => api.get(GATE, { params }).then((r) => r.data),
  create: (payload: Record<string, unknown>) => api.post(GATE, payload).then((r) => r.data),
  assign: (id: string, payload: Record<string, unknown>) => api.patch(`${GATE}/${id}/assign`, payload).then((r) => r.data),
  submit: (id: string) => api.post(`${GATE}/${id}/submit`).then((r) => r.data),
  approve: (id: string, comments?: string) => api.post(`${GATE}/${id}/approve`, { comments }).then((r) => r.data),
  reject: (id: string, reason: string) => api.post(`${GATE}/${id}/reject`, { reason }).then((r) => r.data),
  requestChanges: (id: string, reason: string) => api.post(`${GATE}/${id}/request-changes`, { reason }).then((r) => r.data),
  waive: (id: string, reason: string) => api.post(`${GATE}/${id}/waive`, { reason }).then((r) => r.data),
}

// ---- Saved Monitoring Profiles (Section 5.1 Stage 1) ----
const MPROF = '/monitoring-profiles'
export const monitoringProfilesApi = {
  list: (params?: Record<string, unknown>) => api.get(MPROF, { params }).then((r) => r.data),
  get: (id: string) => api.get(`${MPROF}/${id}`).then((r) => r.data),
  count: (id: string) => api.get(`${MPROF}/${id}/count`).then((r) => r.data),
  create: (payload: Record<string, unknown>) => api.post(MPROF, payload).then((r) => r.data),
  update: (id: string, payload: Record<string, unknown>) => api.put(`${MPROF}/${id}`, payload).then((r) => r.data),
  duplicate: (id: string) => api.post(`${MPROF}/${id}/duplicate`).then((r) => r.data),
  setActive: (id: string, isActive: boolean) => api.patch(`${MPROF}/${id}/active`, { isActive }).then((r) => r.data),
  archive: (id: string) => api.post(`${MPROF}/${id}/archive`).then((r) => r.data),
  restore: (id: string) => api.post(`${MPROF}/${id}/restore`).then((r) => r.data),
}

// ---- Capture & Qualification Evidence (Section 5.1 Stage 3) ----
const EVID = '/capture-evidence'
export const evidenceApi = {
  get: (opportunityId: string) => api.get(`${EVID}/${opportunityId}`).then((r) => r.data),
  refresh: (opportunityId: string) => api.post(`${EVID}/${opportunityId}/refresh`).then((r) => r.data),
  verifyIncumbent: (id: string) => api.patch(`${EVID}/incumbent/${id}/verify`).then((r) => r.data),
  correctIncumbent: (id: string, payload: Record<string, unknown>) => api.patch(`${EVID}/incumbent/${id}/correct`, payload).then((r) => r.data),
  setNotes: (id: string, notes: string | null) => api.patch(`${EVID}/${id}/notes`, { notes }).then((r) => r.data),
}

// ---- In-app notifications (Section 5.2) ----
export const notificationsApi = {
  list: (params?: Record<string, unknown>) => api.get('/notifications', { params }).then((r) => r.data),
  markRead: (id: string) => api.post(`/notifications/${id}/read`).then((r) => r.data),
  markUnread: (id: string) => api.post(`/notifications/${id}/unread`).then((r) => r.data),
  markAllRead: () => api.post('/notifications/read-all').then((r) => r.data),
  archive: (id: string) => api.post(`/notifications/${id}/archive`).then((r) => r.data),
  restore: (id: string) => api.post(`/notifications/${id}/restore`).then((r) => r.data),
}

// ---- Contract Finance & Timekeeping (Section 5 Module 9) ----
const CF = '/contract-finance'
export const financeApi = {
  summary: (contractId: string) => api.get(`${CF}/${contractId}/summary`).then((r) => r.data),
  listFunding: (contractId: string) => api.get(`${CF}/${contractId}/funding`).then((r) => r.data),
  addFunding: (contractId: string, p: Record<string, unknown>) => api.post(`${CF}/${contractId}/funding`, p).then((r) => r.data),
  voidFunding: (txnId: string, reason: string) => api.post(`${CF}/funding/${txnId}/void`, { reason }).then((r) => r.data),
  listRates: (contractId: string) => api.get(`${CF}/${contractId}/rates`).then((r) => r.data),
  addRate: (contractId: string, p: Record<string, unknown>) => api.post(`${CF}/${contractId}/rates`, p).then((r) => r.data),
  listCosts: (contractId: string) => api.get(`${CF}/${contractId}/costs`).then((r) => r.data),
  addCost: (contractId: string, p: Record<string, unknown>) => api.post(`${CF}/${contractId}/costs`, p).then((r) => r.data),
  costAction: (id: string, action: 'submit' | 'approve' | 'reject' | 'void', body: Record<string, unknown> = {}) => api.post(`${CF}/costs/${id}/${action}`, body).then((r) => r.data),
  listTime: (contractId: string) => api.get(`${CF}/${contractId}/time`).then((r) => r.data),
  myTime: () => api.get(`${CF}/time/mine`).then((r) => r.data),
  approvals: () => api.get(`${CF}/time/approvals`).then((r) => r.data),
  addTime: (contractId: string, p: Record<string, unknown>) => api.post(`${CF}/${contractId}/time`, p).then((r) => r.data),
  submitTime: (id: string) => api.post(`${CF}/time/${id}/submit`).then((r) => r.data),
  approveTime: (id: string) => api.post(`${CF}/time/${id}/approve`).then((r) => r.data),
  rejectTime: (id: string, reason: string) => api.post(`${CF}/time/${id}/reject`, { reason }).then((r) => r.data),
  listInvoices: (contractId: string) => api.get(`${CF}/${contractId}/invoices`).then((r) => r.data),
  createInvoice: (contractId: string, p: Record<string, unknown>) => api.post(`${CF}/${contractId}/invoices`, p).then((r) => r.data),
  getInvoice: (id: string) => api.get(`${CF}/invoices/${id}`).then((r) => r.data),
  invoiceAction: (id: string, action: 'approve' | 'submit' | 'void', body: Record<string, unknown> = {}) => api.post(`${CF}/invoices/${id}/${action}`, body).then((r) => r.data),
  addPayment: (invoiceId: string, p: Record<string, unknown>) => api.post(`${CF}/invoices/${invoiceId}/payments`, p).then((r) => r.data),
  receivables: () => api.get(`${CF}/receivables`).then((r) => r.data),

  // Chasing an invoice is recorded against it and never changes its status.
  listFollowUps: (invoiceId: string) => api.get(`${CF}/invoices/${invoiceId}/follow-ups`).then((r) => r.data),
  addFollowUp: (invoiceId: string, p: Record<string, unknown>) =>
    api.post(`${CF}/invoices/${invoiceId}/follow-ups`, p).then((r) => r.data),
  resolveFollowUp: (id: string) => api.post(`${CF}/follow-ups/${id}/resolve`, {}).then((r) => r.data),

  /** An export a person keys into the customer's billing system — not a submission. */
  exportInvoice: async (invoiceId: string, invoiceNumber: string) => {
    const res = await api.get(`${CF}/invoices/${invoiceId}/export`, { responseType: 'blob' })
    const url = URL.createObjectURL(res.data)
    const a = document.createElement('a'); a.href = url; a.download = `${invoiceNumber}.csv`; a.click()
    URL.revokeObjectURL(url)
  },
  /**
   * The whole invoice ledger, one row per line item.
   *
   * Server-side because the list endpoint returns invoice headers only — the
   * lines are fetched per invoice on demand, so a client-side export of what
   * the page happens to hold would drop every line item on the screen.
   */
  exportInvoiceLedger: async (contractId: string, contractNumber: string) => {
    const res = await api.get(`${CF}/${contractId}/invoices/export`, { responseType: 'blob' })
    const url = URL.createObjectURL(res.data)
    const a = document.createElement('a')
    a.href = url; a.download = `invoices-${contractNumber}.csv`; a.click()
    URL.revokeObjectURL(url)
  },
  /** The customer copy. Rendered server-side so it looks the same for everyone. */
  exportInvoicePdf: async (invoiceId: string, invoiceNumber: string) => {
    const res = await api.get(`${CF}/invoices/${invoiceId}/pdf`, { responseType: 'blob' })
    const url = URL.createObjectURL(res.data)
    const a = document.createElement('a'); a.href = url; a.download = `${invoiceNumber}.pdf`; a.click()
    URL.revokeObjectURL(url)
  },

  auditPackage: (params: { fiscalYear: number; contractId?: string }) =>
    api.get(`${CF}/audit-package`, { params }).then((r) => r.data),
  exportAuditPackage: async (fiscalYear: number, contractId?: string) => {
    const res = await api.get(`${CF}/audit-package/export`, { params: { fiscalYear, contractId }, responseType: 'blob' })
    const url = URL.createObjectURL(res.data)
    const a = document.createElement('a'); a.href = url; a.download = `incurred-cost-FY${fiscalYear}.csv`; a.click()
    URL.revokeObjectURL(url)
  },
  rateVariance: (contractId: string) => api.get(`${CF}/${contractId}/rate-variance`).then((r) => r.data),
  alerts: () => api.get(`${CF}/alerts`).then((r) => r.data),
}

// ---- Billing ----
export const billingApi = {
  getPlans: () => api.get('/billing/plans').then((r) => r.data),
  getPublicPlans: () => api.get('/billing/public/plans').then((r) => r.data),
  // Public marketing add-on catalog (no auth required)
  getPublicAddons: () => api.get('/billing/public/addons').then((r) => r.data),
  // Single source of truth for what this firm can access (base plan, all-access,
  // add-on modules, trial, token balances). Consumed by useEntitlements().
  getEntitlements: () => api.get('/billing/entitlements').then((r) => r.data),
  getSubscription: () => api.get('/billing/subscription').then((r) => r.data),
  subscribe: (planId: string, billingCycle: 'MONTHLY' | 'ANNUAL') =>
    api.post('/billing/subscribe', { planId, billingCycle }).then((r) => r.data),
  cancel: () => api.put('/billing/subscription/cancel').then((r) => r.data),
  reactivate: () => api.put('/billing/subscription/reactivate').then((r) => r.data),
  getInvoices: (params?: { page?: number; limit?: number }) =>
    api.get('/billing/invoices', { params }).then((r) => r.data),
  getInvoice: (id: string) => api.get(`/billing/invoices/${id}`).then((r) => r.data),
  generateInvoice: (notes?: string, force?: boolean) =>
    api.post('/billing/invoices/generate', { notes, force }).then((r) => r.data),
  downloadInvoicePdf: (id: string) =>
    api.get(`/billing/invoices/${id}/pdf`, { responseType: 'blob' }).then((r) => r.data),
  updateInvoiceStatus: (id: string, status: string) =>
    api.put(`/billing/invoices/${id}/status`, { status }).then((r) => r.data),

  // Stripe checkout (new endpoints — return { success, data: {...} })
  getStripeCatalog: () =>
    api.get('/billing/stripe/catalog').then((r) => r.data?.data ?? r.data),
  startLifetimeCheckout: (successUrl: string, cancelUrl: string) =>
    api.post('/billing/stripe/checkout/lifetime', { successUrl, cancelUrl })
      .then((r) => r.data?.data ?? r.data),
  startAddonCheckout: (addonSlug: string, successUrl: string, cancelUrl: string, billingCycle?: 'MONTHLY' | 'ANNUAL') =>
    api.post('/billing/stripe/checkout/addon', { addonSlug, successUrl, cancelUrl, billingCycle })
      .then((r) => r.data?.data ?? r.data),
  // New single-plan model accepts 'base' | 'all_access'. The legacy tier slugs
  // are kept in the union only until Billing.tsx migrates — the backend
  // rejects them.
  startSubscriptionCheckout: (tier: 'base' | 'all_access' | 'personal' | 'starter' | 'professional' | 'enterprise', successUrl: string, cancelUrl: string, billingCycle?: 'MONTHLY' | 'ANNUAL') =>
    api.post('/billing/stripe/checkout/subscription', { tier, successUrl, cancelUrl, billingCycle })
      .then((r) => r.data?.data ?? r.data),
  startTokenPackCheckout: (slug: string, successUrl: string, cancelUrl: string) =>
    api.post('/billing/stripe/checkout/token-pack', { slug, successUrl, cancelUrl })
      .then((r) => r.data?.data ?? r.data),
}

// ---- Admin: Backtest ----
export const backtestApi = {
  listRuns: () => api.get('/admin/backtest/runs').then(r => r.data),
  getRun: (id: string) => api.get(`/admin/backtest/runs/${id}`).then(r => r.data),
  startRun: (opts: {
    sampleSize: number
    yearsBack: number
    methodVersion?: 'v1-synthetic' | 'v2-permutation'
    cutoffDate?: string
  }) =>
    api.post('/admin/backtest/run', opts, { timeout: 30 * 60 * 1000 }).then(r => r.data),
  calibrationStatus: () => api.get('/admin/backtest/calibration/status').then(r => r.data),
  refreshCalibration: () => api.post('/admin/backtest/calibration/refresh').then(r => r.data),
}

// ---- Add-ons ----
export const addonsApi = {
  list: () => api.get('/addons').then(r => r.data),
  purchase: (slug: string) => api.post(`/addons/${slug}/purchase`).then(r => r.data),
  cancel: (slug: string) => api.delete(`/addons/${slug}/cancel`).then(r => r.data),
}

// ---- Pursuits (bid lifecycle tracking) ----
export const pursuitsApi = {
  list: (status?: 'REVIEWING' | 'SUBMITTED' | 'PASSED') =>
    api.get('/pursuits', { params: status ? { status } : undefined }).then((r) => r.data),
  awardPrompts: () => api.get('/pursuits/award-prompts').then((r) => r.data),
  // 422 { code:'CLIENT_REQUIRED' } when the firm has ≠1 active client and no
  // clientCompanyId was passed — caller should show a client picker.
  update: (id: string, body: { action: 'submitted' | 'passed' | 'snooze'; clientCompanyId?: string; snoozeDays?: number }) =>
    api.patch(`/pursuits/${id}`, body).then((r) => r.data),
}

// ---- Set-Aside Intelligence ----
export const setAsideApi = {
  overview: () => api.get('/setaside/overview').then((r) => r.data),
  scanner: (params?: { type?: string; limit?: number }) =>
    api.get('/setaside/scanner', { params }).then((r) => r.data),
  eligibility: (opportunityId: string) =>
    api.get(`/setaside/eligibility/${opportunityId}`).then((r) => r.data),
  agencyRates: () => api.get('/setaside/agency-rates').then((r) => r.data),
}

export const proposalAssistApi = {
  generateOutline: (opportunityId: string, signal?: AbortSignal) =>
    api.post(`/proposal-assist/${opportunityId}/outline`, {}, { timeout: 120000, signal }).then(r => {
      trackEvent('ai_feature_used', { feature: 'proposal_outline', opportunityId });
      return r.data;
    }),
  generateQuestions: (opportunityId: string, outline: any) =>
    api.post(`/proposal-assist/${opportunityId}/questions`, { outline }, { timeout: 60000 }).then(r => r.data),
  generateDraftPdf: (opportunityId: string, answers: any[], userGuidance?: string, bidFormContext?: string, clientCompanyId?: string) =>
    api.post(
      `/proposal-assist/${opportunityId}/draft`,
      { answers, userGuidance, bidFormContext, clientCompanyId },
      { timeout: 600000, responseType: 'blob' },
    ).then((r) => {
      const partial = String(r.headers['x-draft-partial'] || '').toLowerCase() === 'true';
      trackEvent('proposal_generated', { opportunityId, partial });
      trackEvent('ai_feature_used', { feature: 'proposal_draft', opportunityId });
      return {
        blob: r.data as Blob,
        // Surfaced via Access-Control-Expose-Headers on the backend. When true,
        // the LLM hit max_tokens and the PDF contains only the salvaged sections
        // (caller should warn the user before submission).
        partial,
      };
    }),
  getSaved: (opportunityId: string) =>
    api.get(`/proposal-assist/${opportunityId}/saved`).then(r => r.data),
  saveDraft: (opportunityId: string, data: { outline?: any; answers?: any; step?: string }) =>
    api.put(`/proposal-assist/${opportunityId}/saved`, data).then(r => r.data),
  downloadSavedDraftPdf: (opportunityId: string) =>
    api.get(`/proposal-assist/${opportunityId}/saved-draft/pdf`, { responseType: 'blob' }).then(r => r.data),
  // FIX-6 human-in-the-loop attestation
  getAttestation: (opportunityId: string) =>
    api.get(`/proposal-assist/${opportunityId}/attestation`).then(r => r.data),
  attest: (opportunityId: string, draftContentHash: string) =>
    api.post(`/proposal-assist/${opportunityId}/attest`, { confirmed: true, draftContentHash }).then(r => r.data),
  downloadFinalPdf: async (opportunityId: string) => {
    try {
      const res = await api.get(`/proposal-assist/${opportunityId}/final-pdf`, { responseType: 'blob' })
      return res.data
    } catch (err: any) {
      // Error responses arrive as Blobs under responseType:'blob' — surface
      // the backend's actionable message (ATTESTATION_STALE/REQUIRED) instead
      // of a generic failure.
      const data = err?.response?.data
      if (data instanceof Blob && data.type === 'application/json') {
        try {
          const parsed = JSON.parse(await data.text())
          if (parsed?.error) throw new Error(parsed.error)
        } catch (e) {
          if (e instanceof Error && e.message && !(e instanceof SyntaxError)) throw e
        }
      }
      throw err
    }
  },
}

// ---- Compliance Matrix ----
export const complianceMatrixApi = {
  get: (opportunityId: string) =>
    api.get(`/compliance-matrix/${opportunityId}`).then((r) => r.data),
  generate: (opportunityId: string) =>
    api.post(`/compliance-matrix/${opportunityId}/generate`, {}, { timeout: 90000 }).then((r) => {
      trackEvent('requirement_extraction_run', { opportunityId });
      trackEvent('ai_feature_used', { feature: 'compliance_matrix', opportunityId });
      return r.data;
    }),
  updateRequirement: (requirementId: string, data: { proposalSection?: string; status?: string; notes?: string }) =>
    api.patch(`/compliance-matrix/requirements/${requirementId}`, data).then((r) => r.data),
  generateBidGuidance: (opportunityId: string, signal?: AbortSignal) =>
    api.post(`/compliance-matrix/${opportunityId}/bid-guidance`, {}, { timeout: 90000, signal }).then((r) => r.data),
  // §5.2 verification, ownership, linking, filters, non-destructive re-extract
  summary: (opportunityId: string, params?: { mandatory?: boolean; unverified?: boolean; incomplete?: boolean }) =>
    api.get(`/compliance-matrix/${opportunityId}/summary`, { params }).then((r) => r.data),
  addRequirement: (opportunityId: string, data: { requirementText: string; sectionType?: string; section?: string; isMandatory?: boolean; proposalSection?: string; evidenceText?: string; sourcePageNumber?: number }) =>
    api.post(`/compliance-matrix/${opportunityId}/requirements`, data).then((r) => r.data),
  verifyRequirement: (requirementId: string) =>
    api.post(`/compliance-matrix/requirements/${requirementId}/verify`, {}).then((r) => r.data),
  rejectRequirement: (requirementId: string, reason: string) =>
    api.post(`/compliance-matrix/requirements/${requirementId}/reject`, { reason }).then((r) => r.data),
  assignOwner: (requirementId: string, ownerUserId: string | null) =>
    api.post(`/compliance-matrix/requirements/${requirementId}/assign`, { ownerUserId }).then((r) => r.data),
  linkSection: (requirementId: string, proposalSectionId: string | null) =>
    api.post(`/compliance-matrix/requirements/${requirementId}/link-section`, { proposalSectionId }).then((r) => r.data),
  reExtract: (opportunityId: string, signal?: AbortSignal) =>
    api.post(`/compliance-matrix/${opportunityId}/re-extract`, {}, { timeout: 120000, signal }).then((r) => r.data),
}

// ---- Proposal Workspace + Responsibility Matrix (§5.1 Stage 5) ----
export const proposalApi = {
  getWorkspace: (opportunityId: string) =>
    api.get(`/proposal/opportunity/${opportunityId}`).then((r) => r.data),
  create: (opportunityId: string, title: string) =>
    api.post(`/proposal/opportunity/${opportunityId}`, { title }).then((r) => r.data),
  archive: (proposalId: string) =>
    api.post(`/proposal/${proposalId}/archive`, {}).then((r) => r.data),
  rename: (proposalId: string, title: string) =>
    api.patch(`/proposal/${proposalId}`, { title }).then((r) => r.data),
  restore: (proposalId: string) =>
    api.post(`/proposal/${proposalId}/restore`, {}).then((r) => r.data),
  listArchived: (opportunityId: string) =>
    api.get(`/proposal/opportunity/${opportunityId}/archived`).then((r) => r.data),
  generateOutline: (proposalId: string) =>
    api.post(`/proposal/${proposalId}/outline`, {}).then((r) => r.data),
  addSection: (proposalId: string, data: Record<string, unknown>) =>
    api.post(`/proposal/${proposalId}/sections`, data).then((r) => r.data),
  updateSection: (sectionId: string, data: Record<string, unknown>) =>
    api.patch(`/proposal/sections/${sectionId}`, data).then((r) => r.data),
  reorder: (proposalId: string, orderedIds: string[]) =>
    api.post(`/proposal/${proposalId}/sections/reorder`, { orderedIds }).then((r) => r.data),
  deleteSection: (sectionId: string) =>
    api.delete(`/proposal/sections/${sectionId}`).then((r) => r.data),
  reopenSection: (sectionId: string) =>
    api.post(`/proposal/sections/${sectionId}/reopen`, {}).then((r) => r.data),
  restoreSection: (sectionId: string) =>
    api.post(`/proposal/sections/${sectionId}/restore`, {}).then((r) => r.data),
  restoreVersion: (sectionId: string, version: number) =>
    api.post(`/proposal/sections/${sectionId}/versions/${version}/restore`, {}).then((r) => r.data),
  assignWriter: (sectionId: string, ownerUserId: string | null) =>
    api.post(`/proposal/sections/${sectionId}/assign`, { ownerUserId }).then((r) => r.data),
  setReviewer: (sectionId: string, reviewerUserId: string | null) =>
    api.post(`/proposal/sections/${sectionId}/reviewer`, { reviewerUserId }).then((r) => r.data),
  saveContent: (sectionId: string, content: string) =>
    api.put(`/proposal/sections/${sectionId}/content`, { content }).then((r) => r.data),
  listVersions: (sectionId: string) =>
    api.get(`/proposal/sections/${sectionId}/versions`).then((r) => r.data),
  listReviews: (sectionId: string) =>
    api.get(`/proposal/sections/${sectionId}/reviews`).then((r) => r.data),
  submit: (sectionId: string) =>
    api.post(`/proposal/sections/${sectionId}/submit`, {}).then((r) => r.data),
  approve: (sectionId: string) =>
    api.post(`/proposal/sections/${sectionId}/approve`, {}).then((r) => r.data),
  requestChanges: (sectionId: string, comment: string) =>
    api.post(`/proposal/sections/${sectionId}/request-changes`, { comment }).then((r) => r.data),
  resubmit: (sectionId: string) =>
    api.post(`/proposal/sections/${sectionId}/resubmit`, {}).then((r) => r.data),
  generateDraft: (sectionId: string, data: { evaluationCriteria?: string; companyCapabilities?: string; approvedPastPerformance?: string }, signal?: AbortSignal) =>
    api.post(`/proposal/sections/${sectionId}/draft`, data, { timeout: 120000, signal }).then((r) => r.data),
  cancelDraft: (sectionId: string) =>
    api.post(`/proposal/sections/${sectionId}/draft/cancel`, {}).then((r) => r.data),
  responsibility: (proposalId: string, params?: { writerUserId?: string; reviewerUserId?: string; status?: string; dueBefore?: string; overdue?: boolean }) =>
    api.get(`/proposal/${proposalId}/responsibility`, { params }).then((r) => r.data),
}

// ---- Pricing & Rate Build-Up (§5.1 Stage 6 / §5.2) ----
export const pricingApi = {
  getWorkspace: (opportunityId: string) => api.get(`/pricing/opportunity/${opportunityId}`).then((r) => r.data),
  get: (workspaceId: string) => api.get(`/pricing/${workspaceId}`).then((r) => r.data),
  create: (opportunityId: string, body: { title: string; contractType?: string; proposalId?: string }) => api.post(`/pricing/opportunity/${opportunityId}`, body).then((r) => r.data),
  archive: (workspaceId: string) => api.post(`/pricing/${workspaceId}/archive`, {}).then((r) => r.data),
  restore: (workspaceId: string) => api.post(`/pricing/${workspaceId}/restore`, {}).then((r) => r.data),
  rename: (workspaceId: string, title: string) => api.patch(`/pricing/${workspaceId}`, { title }).then((r) => r.data),
  restoreScenario: (scenarioId: string) => api.post(`/pricing/scenarios/${scenarioId}/restore`, {}).then((r) => r.data),
  newVersion: (workspaceId: string) => api.post(`/pricing/${workspaceId}/version`, {}).then((r) => r.data),
  submit: (workspaceId: string) => api.post(`/pricing/${workspaceId}/submit`, {}).then((r) => r.data),
  approve: (workspaceId: string) => api.post(`/pricing/${workspaceId}/approve`, {}).then((r) => r.data),
  reject: (workspaceId: string, comment: string) => api.post(`/pricing/${workspaceId}/reject`, { comment }).then((r) => r.data),
  requestChanges: (workspaceId: string, comment: string) => api.post(`/pricing/${workspaceId}/request-changes`, { comment }).then((r) => r.data),
  reviews: (workspaceId: string) => api.get(`/pricing/${workspaceId}/reviews`).then((r) => r.data),
  compare: (workspaceId: string) => api.get(`/pricing/${workspaceId}/compare`).then((r) => r.data),
  benchmark: (opportunityId: string) => api.get(`/pricing/opportunity/${opportunityId}/benchmark`).then((r) => r.data),
  addScenario: (workspaceId: string, body: { name: string; description?: string }) => api.post(`/pricing/${workspaceId}/scenarios`, body).then((r) => r.data),
  duplicateScenario: (scenarioId: string) => api.post(`/pricing/scenarios/${scenarioId}/duplicate`, {}).then((r) => r.data),
  updateScenario: (scenarioId: string, body: Record<string, unknown>) => api.patch(`/pricing/scenarios/${scenarioId}`, body).then((r) => r.data),
  selectScenario: (workspaceId: string, scenarioId: string) => api.post(`/pricing/${workspaceId}/scenarios/${scenarioId}/select`, {}).then((r) => r.data),
  deleteScenario: (scenarioId: string) => api.delete(`/pricing/scenarios/${scenarioId}`).then((r) => r.data),
  addLabor: (scenarioId: string, body: Record<string, unknown>) => api.post(`/pricing/scenarios/${scenarioId}/labor`, body).then((r) => r.data),
  updateLabor: (id: string, body: Record<string, unknown>) => api.patch(`/pricing/labor/${id}`, body).then((r) => r.data),
  deleteLabor: (id: string) => api.delete(`/pricing/labor/${id}`).then((r) => r.data),
  addIndirect: (scenarioId: string, body: Record<string, unknown>) => api.post(`/pricing/scenarios/${scenarioId}/indirect`, body).then((r) => r.data),
  updateIndirect: (id: string, body: Record<string, unknown>) => api.patch(`/pricing/indirect/${id}`, body).then((r) => r.data),
  deleteIndirect: (id: string) => api.delete(`/pricing/indirect/${id}`).then((r) => r.data),
  addOther: (scenarioId: string, body: Record<string, unknown>) => api.post(`/pricing/scenarios/${scenarioId}/other`, body).then((r) => r.data),
  updateOther: (id: string, body: Record<string, unknown>) => api.patch(`/pricing/other/${id}`, body).then((r) => r.data),
  deleteOther: (id: string) => api.delete(`/pricing/other/${id}`).then((r) => r.data),
  templates: () => api.get('/pricing/templates').then((r) => r.data),
  createTemplate: (body: Record<string, unknown>) => api.post('/pricing/templates', body).then((r) => r.data),
  applyTemplate: (scenarioId: string, templateId: string) => api.post(`/pricing/scenarios/${scenarioId}/apply-template/${templateId}`, {}).then((r) => r.data),
}

// ---- Submission Management (§5.1 Stage 7) ----
export const submissionApi = {
  getWorkspace: (opportunityId: string) => api.get(`/submission/opportunity/${opportunityId}`).then((r) => r.data),
  get: (submissionId: string) => api.get(`/submission/${submissionId}`).then((r) => r.data),
  create: (opportunityId: string, body: { title: string; finalDeadline?: string; internalDeadline?: string; submissionMethod?: string; proposalId?: string }) => api.post(`/submission/opportunity/${opportunityId}`, body).then((r) => r.data),
  update: (submissionId: string, body: Record<string, unknown>) => api.patch(`/submission/${submissionId}`, body).then((r) => r.data),
  archive: (submissionId: string) => api.post(`/submission/${submissionId}/archive`, {}).then((r) => r.data),
  generateChecklist: (submissionId: string) => api.post(`/submission/${submissionId}/generate-checklist`, {}).then((r) => r.data),
  addItem: (submissionId: string, body: Record<string, unknown>) => api.post(`/submission/${submissionId}/items`, body).then((r) => r.data),
  updateItem: (itemId: string, body: Record<string, unknown>) => api.patch(`/submission/items/${itemId}`, body).then((r) => r.data),
  block: (itemId: string, reason: string) => api.post(`/submission/items/${itemId}/block`, { reason }).then((r) => r.data),
  resolveBlocker: (itemId: string) => api.post(`/submission/items/${itemId}/resolve-blocker`, {}).then((r) => r.data),
  validateItem: (itemId: string, body: Record<string, unknown>) => api.post(`/submission/items/${itemId}/validate`, body).then((r) => r.data),
  deleteItem: (itemId: string) => api.delete(`/submission/items/${itemId}`).then((r) => r.data),
  restoreItem: (itemId: string) => api.post(`/submission/items/${itemId}/restore`, {}).then((r) => r.data),
  readiness: (submissionId: string) => api.get(`/submission/${submissionId}/readiness`).then((r) => r.data),
  markReady: (submissionId: string, overrideReason?: string) => api.post(`/submission/${submissionId}/mark-ready`, overrideReason ? { overrideReason } : {}).then((r) => r.data),
  submit: (submissionId: string, body: Record<string, unknown>) => api.post(`/submission/${submissionId}/submit`, body).then((r) => r.data),
  history: (submissionId: string) => api.get(`/submission/${submissionId}/history`).then((r) => r.data),
  reminders: (submissionId: string) => api.get(`/submission/${submissionId}/reminders`).then((r) => r.data),
}

// ---- Past Performance Library & Matrix (§5.1 Stage 10 / §5.2) ----
export const pastPerformanceLibraryApi = {
  list: (params?: Record<string, unknown>) => api.get('/past-performance-library', { params }).then((r) => r.data),
  get: (id: string) => api.get(`/past-performance-library/${id}`).then((r) => r.data),
  create: (body: Record<string, unknown>) => api.post('/past-performance-library', body).then((r) => r.data),
  update: (id: string, body: Record<string, unknown>) => api.patch(`/past-performance-library/${id}`, body).then((r) => r.data),
  verify: (id: string, status?: string) => api.post(`/past-performance-library/${id}/verify`, status ? { status } : {}).then((r) => r.data),
  /** An approved record is immutable. Reopening is what makes it editable again. */
  reopen: (id: string) => api.post(`/past-performance-library/${id}/reopen`, {}).then((r) => r.data),
  archive: (id: string) => api.post(`/past-performance-library/${id}/archive`, {}).then((r) => r.data),
  restore: (id: string) => api.post(`/past-performance-library/${id}/restore`, {}).then((r) => r.data),
  fromContract: (contractId: string) => api.post(`/past-performance-library/from-contract/${contractId}`, {}).then((r) => r.data),
  matrix: (opportunityId: string) => api.get(`/past-performance-library/matrix/${opportunityId}`).then((r) => r.data),
  score: (opportunityId: string) => api.post(`/past-performance-library/matrix/${opportunityId}/score`, {}).then((r) => r.data),
  select: (opportunityId: string, recordId: string, body?: Record<string, unknown>) => api.post(`/past-performance-library/matrix/${opportunityId}/select/${recordId}`, body ?? {}).then((r) => r.data),
  deselect: (opportunityId: string, recordId: string) => api.post(`/past-performance-library/matrix/${opportunityId}/deselect/${recordId}`, {}).then((r) => r.data),
  adapt: (id: string, body: { opportunityId?: string; userNotes?: string }) => api.post(`/past-performance-library/${id}/adapt`, body).then((r) => r.data),
}

// ---- Market Analytics (BigQuery-powered) ----
export const marketAnalyticsApi = {
  status: () =>
    api.get('/market-analytics/status').then((r) => r.data),
  competition: (naicsCode: string, agency?: string) =>
    api.get(`/market-analytics/competition/${naicsCode}`, { params: agency ? { agency } : {} }).then((r) => r.data),
  agency: (agencyName: string) =>
    api.get(`/market-analytics/agency/${encodeURIComponent(agencyName)}`).then((r) => r.data),
  contractor: (name: string) =>
    api.get(`/market-analytics/contractor/${encodeURIComponent(name)}`).then((r) => r.data),
  snapshot: (params?: { naics?: string; years?: number }) =>
    api.get('/market-analytics/snapshot', { params }).then((r) => r.data),
  preview: (params?: { clientId?: string; naics?: string; years?: number }) =>
    api.get('/market-analytics/preview', { params }).then((r) => r.data),
  insights: () =>
    api.get('/market-analytics/insights').then((r) => r.data),
  ingest: (body: { naicsCode?: string; agency?: string; bulk?: boolean; maxPages?: number }) =>
    api.post('/market-analytics/ingest', body).then((r) => r.data),
  // Watchlist
  listWatchlist: () =>
    api.get('/market-analytics/watchlist').then((r) => r.data),
  addWatchlist: (body: { naicsCode?: string; agency?: string }) =>
    api.post('/market-analytics/watchlist', body).then((r) => r.data),
  removeWatchlist: (id: string) =>
    api.delete(`/market-analytics/watchlist/${id}`).then((r) => r.data),
}

// ---- State & Municipal ----
export const stateMunicipalApi = {
  list: (params?: { state?: string; level?: string; limit?: number; offset?: number; search?: string }) =>
    api.get('/state-municipal/opportunities', { params }).then((r) => r.data),
  stats: () => api.get('/state-municipal/stats').then((r) => r.data),
  sync: () => api.post('/state-municipal/sync').then((r) => r.data),
  create: (data: Record<string, unknown>) => api.post('/state-municipal/opportunities', data).then((r) => r.data),
  delete: (id: string) => api.delete(`/state-municipal/opportunities/${id}`).then((r) => r.data),
  clearAll: () => api.delete('/state-municipal/all').then((r) => r.data),
  previewImport: (file: File, defaultState?: string) => {
    const fd = new FormData()
    fd.append('file', file)
    if (defaultState) fd.append('defaultState', defaultState)
    return api.post('/state-municipal/import?preview=true', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data)
  },
  bulkImport: (file: File, defaultState?: string) => {
    const fd = new FormData()
    fd.append('file', file)
    if (defaultState) fd.append('defaultState', defaultState)
    return api.post('/state-municipal/import', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data)
  },
}

// ---- Subcontracting ----
export const subcontractingApi = {
  list: (params?: { search?: string; naicsCode?: string; setAside?: string; agency?: string; status?: string; limit?: number; offset?: number }) =>
    api.get('/subcontracting/opportunities', { params }).then((r) => r.data),
  stats: () => api.get('/subcontracting/stats').then((r) => r.data),
  sync: () => api.post('/subcontracting/sync').then((r) => r.data),
  create: (data: Record<string, unknown>) => api.post('/subcontracting/opportunities', data).then((r) => r.data),
  delete: (id: string) => api.delete(`/subcontracting/opportunities/${id}`).then((r) => r.data),
  saveToPipeline: (id: string) => api.post(`/subcontracting/opportunities/${id}/save-to-pipeline`).then((r) => r.data),
  dismiss: (id: string, reason: string) => api.post(`/subcontracting/opportunities/${id}/dismiss`, { reason }).then((r) => r.data),

  // ---- Perpetual prime-contact (POC) directory ----
  contacts: (params?: { search?: string; agency?: string; naicsCode?: string; prime?: string; source?: string; limit?: number; offset?: number }) =>
    api.get('/subcontracting/contacts', { params }).then((r) => r.data),
  contactStats: () => api.get('/subcontracting/contacts/stats').then((r) => r.data),
  deleteContact: (id: string) => api.delete(`/subcontracting/contacts/${id}`).then((r) => r.data),
  pruneContacts: () => api.post('/subcontracting/contacts/prune').then((r) => r.data),
}

// ---- Teaming Partner CRM + Graph (FIX-2 moat) ----
export const teamingApi = {
  listPartners: (params?: { search?: string; activeOnly?: boolean; includeArchived?: boolean; naicsCode?: string; setAside?: string; partnerType?: string }) =>
    api.get('/teaming/partners', { params }).then((r) => r.data),
  getPartner: (id: string) => api.get(`/teaming/partners/${id}`).then((r) => r.data),
  createPartner: (data: Record<string, unknown>) => api.post('/teaming/partners', data).then((r) => r.data),
  updatePartner: (id: string, data: Record<string, unknown>) => api.put(`/teaming/partners/${id}`, data).then((r) => r.data),
  archivePartner: (id: string) => api.patch(`/teaming/partners/${id}/archive`).then((r) => r.data),
  restorePartner: (id: string) => api.patch(`/teaming/partners/${id}/restore`).then((r) => r.data),
  updatePartnerNotes: (id: string, notes: string | null) => api.patch(`/teaming/partners/${id}/notes`, { notes }).then((r) => r.data),
  deletePartner: (id: string, typedNameConfirmation: string) => api.delete(`/teaming/partners/${id}`, { data: { typedNameConfirmation } }).then((r) => r.data),
  listArrangements: (params?: { opportunityId?: string; partnerId?: string }) =>
    api.get('/teaming/arrangements', { params }).then((r) => r.data),
  createArrangement: (data: Record<string, unknown>) => api.post('/teaming/arrangements', data).then((r) => r.data),
  updateArrangement: (id: string, data: Record<string, unknown>) => api.patch(`/teaming/arrangements/${id}`, data).then((r) => r.data),
  deleteArrangement: (id: string) => api.delete(`/teaming/arrangements/${id}`).then((r) => r.data),
  graph: () => api.get('/teaming/graph').then((r) => r.data),
  recommend: (opportunityId: string) => api.get(`/teaming/recommend/${opportunityId}`).then((r) => r.data),
  // §5.1 Stage 4 — agreement drafts, attachments, reminders
  generateDraft: (arrangementId: string, payload: Record<string, unknown>) => api.post(`/teaming/arrangements/${arrangementId}/agreement-draft`, payload).then((r) => r.data),
  listDrafts: (arrangementId: string) => api.get(`/teaming/arrangements/${arrangementId}/agreement-drafts`).then((r) => r.data),
  uploadAttachment: (arrangementId: string, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return api.post(`/teaming/arrangements/${arrangementId}/attachment`, fd, { headers: { 'Content-Type': 'multipart/form-data' } }).then((r) => r.data)
  },
  reminders: () => api.get('/teaming/reminders').then((r) => r.data),
  dispatchReminders: () => api.post('/teaming/reminders/dispatch').then((r) => r.data),
}

// ---- AI Assistant ----
export const assistantApi = {
  chat: (message: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) =>
    api.post('/assistant/chat', { message, history }, { timeout: 60000 }).then((r) => {
      trackEvent('ai_feature_used', { feature: 'assistant_chat' });
      return r.data;
    }),
}

// ---- Agency-centric subcontracting + teaming ----
export const agencyApi = {
  list: () => api.get('/agency').then((r) => r.data),
  primes: (
    agencyCode: string,
    sort?: 'totalDollars' | 'awardCount' | 'subSpendRatio' | 'naicsCoverage',
    minDollars?: number,
  ) =>
    api
      .get(`/agency/${agencyCode}/primes`, {
        params: { ...(sort ? { sort } : {}), ...(minDollars !== undefined ? { minDollars } : {}) },
      })
      .then((r) => r.data),
  subs: (agencyCode: string) =>
    api.get(`/agency/${agencyCode}/subs`).then((r) => r.data),
  profile: (agencyCode: string, windowYears = 3) =>
    api.get(`/agency/${agencyCode}/profile`, { params: { windowYears } }).then((r) => r.data),
  primeDetail: (agencyCode: string, uei: string) =>
    api.get(`/agency/${agencyCode}/primes/${uei}`).then((r) => r.data),
  fit: (agencyCode: string, uei: string, clientId: string) =>
    api.get(`/agency/${agencyCode}/primes/${uei}/fit`, { params: { clientId } }).then((r) => r.data),
  draftOutreach: (clientId: string, primeUei: string, agencyCode: string) =>
    api
      .post('/agency/draft-outreach', { clientId, primeUei, agencyCode }, { timeout: 90000 })
      .then((r) => r.data),
  listRelationships: (params?: { status?: string; clientId?: string }) =>
    api.get('/agency/relationships', { params }).then((r) => r.data),
  saveRelationship: (body: {
    clientId: string
    primeUei: string
    agencyCode: string
    fitScoreAtSave?: number | null
    notes?: string
  }) =>
    api.post('/agency/relationships', body).then((r) => r.data),
  updateRelationship: (id: string, body: { status?: string; notes?: string }) =>
    api.patch(`/agency/relationships/${id}`, body).then((r) => r.data),
  deleteRelationship: (id: string) =>
    api.delete(`/agency/relationships/${id}`).then((r) => r.data),
}

// ---- GB-106 Platform & Vehicle Onboarding ----
// The onboarding controller returns the plan object directly (not the
// { success, data } envelope), matching the module's transport-agnostic hook.
export const onboardingApi = {
  getPlan: () => api.get('/onboarding/plan').then((r) => r.data),
  getPrograms: () => api.get('/onboarding/programs').then((r) => r.data),
  updateProgress: (programCode: string, status: string, notes?: string) =>
    api.put('/onboarding/progress', { programCode, status, notes }).then((r) => r.data),
}

// ---- MCP API tokens (self-service, ADMIN) ----
// One credential table, two delivery interfaces. `kind` decides which one a
// token works with: an MCP host credential is refused by the public REST API
// and a PUBLIC_API credential is refused by the MCP servers.
export const mcpApi = {
  listTokens: () => api.get('/admin/mcp/tokens').then((r) => r.data),
  createToken: (name: string) => api.post('/admin/mcp/tokens', { name }).then((r) => r.data),
  createPublicApiToken: (name: string, scopes: string[], tier: string, expiresInDays?: number) =>
    api.post('/admin/mcp/tokens', {
      name, scopes, tier, kind: 'PUBLIC_API',
      ...(expiresInDays ? { expiresInDays } : {}),
    }).then((r) => r.data),
  revokeToken: (id: string) => api.delete(`/admin/mcp/tokens/${id}`).then((r) => r.data),
}

// ---- Recipient drill-down (UEI -> SAM profile + subaward/prime history) ----
export const recipientApi = {
  profile: (uei: string, opts?: { refresh?: boolean }) =>
    api
      .get(`/recipient/${uei}`, { params: opts?.refresh ? { refresh: '1' } : undefined })
      .then((r) => r.data),
  subawards: (uei: string, limit = 50) =>
    api.get(`/recipient/${uei}/subawards`, { params: { limit } }).then((r) => r.data),
  primes: (uei: string, limit = 50) =>
    api.get(`/recipient/${uei}/primes`, { params: { limit } }).then((r) => r.data),
  enrichContacts: (uei: string, provider?: string) =>
    api
      .post(`/recipient/${uei}/enrich-contacts`, provider ? { provider } : {}, { timeout: 30000 })
      .then((r) => r.data),
}

// ---- Manual Contract Upload ----
export const contractsApi = {
  upload: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return api.post('/contracts/upload', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120000,
    }).then((r) => r.data)
  },
  listManual: () =>
    api.get('/contracts/manual').then((r) => r.data),
}

// ---- SCW (Subcontracting Workflow) ----
// Backend types live in backend/src/services/scw/likelyPrimes.ts — kept in
// sync by hand here to avoid a cross-package import. If you add a field to
// LikelyPrime there, mirror it below.
export interface ScwComponentBreakdown {
  raw: number
  weight: number
  weighted: number
  confidence: number
  reasoning: string
}
export interface ScwLikelyPrime {
  primeUei: string
  primeName: string
  pastAwardsCount: number
  totalPastValue: number
  mostRecentAward: string | null
  contact: {
    name: string | null
    email: string | null
    phone: string | null
    source: 'recipient_profiles_cache' | 'sam_gov_live' | 'manual_research_required'
  }
  sdvosbCertified: boolean
  businessSize: string | null
  confidence: {
    composite: number
    components: {
      awardFrequency: ScwComponentBreakdown
      awardRecency: ScwComponentBreakdown
      dollarVolume: ScwComponentBreakdown
      subawardPropensity: ScwComponentBreakdown
      sdvosbGoalGap: ScwComponentBreakdown
    }
    topReasons: string[]
    citation: string
  }
  dataQuality: {
    hasContact: boolean
    hasSubawardHistory: boolean
    hasSdvosbGoalData: boolean
    warnings: string[]
  }
}

export interface ScwSubawardAnalysis {
  primeUei: string | null
  primeName: string | null
  lookbackYears: number
  totalSubawardDollars: number | null
  averageSubSize: number | null
  smallBusinessSubAwardPercent: number | null
  sdvosbSubAwardPercent: number | null
  topNaicsSubbed: Array<{ naicsCode: string; dollars: number; count: number }> | null
  sdvosbGoalGap: {
    fiscalYear: string
    goalPercent: number | null
    actualPercent: number | null
    gapPercent: number | null
    underPressure: boolean
    source: 'esrs' | 'computed_proxy' | 'unknown'
  }
  dataQuality: { sampleSize: number; warnings: string[] }
  computedAt: string
  fromCache: boolean
}

export const scwApi = {
  likelyPrimes: (opportunityId: string): Promise<{ success: boolean; data: ScwLikelyPrime[] }> =>
    api.get(`/scw/opportunities/${opportunityId}/primes`).then((r) => r.data),

  /** identifier may be a 12-char UEI or a URL-encoded prime recipient name. */
  subawardAnalysis: (
    identifier: string,
    lookbackYears?: number,
  ): Promise<{ success: boolean; data: ScwSubawardAnalysis }> =>
    api
      .get(`/scw/primes/${encodeURIComponent(identifier)}/subaward-analysis`, {
        params: lookbackYears ? { lookbackYears } : undefined,
      })
      .then((r) => r.data),

  draftOutreach: (input: {
    opportunityId: string
    primeUei?: string | null
    primeName?: string | null
    outreachType: 'cold_first_touch' | 'warm_follow_up' | 'urgent_deadline_driven'
    tenantCapabilityStatement: string
  }): Promise<{ success: boolean; data: ScwOutreachDraft }> =>
    api.post('/scw/outreach/draft', input).then((r) => r.data),

  listOutreachDrafts: (params?: {
    opportunityId?: string
    requiresHumanReview?: boolean
  }): Promise<{ success: boolean; data: ScwOutreachDraft[] }> =>
    api.get('/scw/outreach/drafts', { params }).then((r) => r.data),

  approveOutreachDraft: (id: string): Promise<{ success: boolean; data: ScwOutreachDraft }> =>
    api.patch(`/scw/outreach/drafts/${id}/approve`).then((r) => r.data),

  notificationInbox: (limit?: number): Promise<{ success: boolean; data: ScwSubBidNotification[] }> =>
    api.get('/scw/notifications/inbox', { params: limit ? { limit } : undefined }).then((r) => r.data),
}

export interface ScwSubBidNotification {
  opportunityId: string
  opportunityTitle: string
  agency: string
  setAsideType: string
  daysRemaining: number
  recommendation: 'BID_SUB'
  winProbability: number | null
  netExpectedValue: number | null
  topPrimes: Array<{ name: string; confidence: number }>
  ctaUrl: string
}

export interface ScwOutreachDraft {
  id: string
  opportunityId: string
  primeUei: string | null
  primeName: string
  outreachType: 'cold_first_touch' | 'warm_follow_up' | 'urgent_deadline_driven'
  subject: string
  body: string
  salutation: string
  closing: string
  factsCited: Array<{ claim: string; source: string }>
  reviewChecklist: string[]
  requiresHumanReview: boolean
  humanApprovedAt?: string | null
  // GB-104 — recipient email + verification gating.
  recipientEmail?: string | null
  emailVerificationStatus?: 'verified' | 'probable' | 'unknown'
  emailSource?: string | null
  autoSendBlocked?: boolean
  llmProvider?: string | null
  llmModel?: string | null
  tokensUsed?: number | null
  createdAt: string
}
