// =============================================================
// §8.1 — API client for the GovCon CRM.
//
// Uses the shared `api` axios instance so auth, 401 handling and paywall
// events behave exactly as everywhere else. Relationship strength is never
// computed here — the backend is the single source of truth for it.
// =============================================================
import { api } from './api'

export type GovContactRole =
  | 'CONTRACTING_OFFICER' | 'CONTRACT_SPECIALIST' | 'COR'
  | 'PROGRAM_MANAGER' | 'SMALL_BUSINESS_SPECIALIST' | 'TECHNICAL_LEAD' | 'OTHER'

export type CrmActivityType =
  | 'CALL' | 'MEETING' | 'EMAIL' | 'INDUSTRY_DAY' | 'SITE_VISIT'
  | 'CAPABILITY_BRIEFING' | 'CONFERENCE' | 'NOTE' | 'OTHER'

export type CrmFollowUpStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED'
export type CrmPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
export type CrmContactStatus = 'ACTIVE' | 'INACTIVE' | 'DEPARTED'
export type RelationshipState = 'NO_DATA' | 'WEAK' | 'DEVELOPING' | 'ACTIVE' | 'STRONG'

export const CONTACT_ROLE_LABELS: Record<GovContactRole, string> = {
  CONTRACTING_OFFICER: 'Contracting Officer',
  CONTRACT_SPECIALIST: 'Contract Specialist',
  COR: 'COR',
  PROGRAM_MANAGER: 'Program Manager',
  SMALL_BUSINESS_SPECIALIST: 'Small Business Specialist',
  TECHNICAL_LEAD: 'Technical Lead',
  OTHER: 'Other',
}

export const ACTIVITY_TYPE_LABELS: Record<CrmActivityType, string> = {
  CALL: 'Call',
  MEETING: 'Meeting',
  EMAIL: 'Email',
  INDUSTRY_DAY: 'Industry day',
  SITE_VISIT: 'Site visit',
  CAPABILITY_BRIEFING: 'Capability briefing',
  CONFERENCE: 'Conference',
  NOTE: 'Note',
  OTHER: 'Other',
}

export interface RelationshipStrength {
  state: RelationshipState
  score: number | null
  reason: string
  evidence: Array<{ factor: string; detail: string; points: number }>
  totalInteractions: number
  meaningfulInteractions: number
  lastInteractionAt: string | null
  daysSinceLastInteraction: number | null
}

export interface AgencyOffice {
  id: string
  agencyName: string
  officeName: string
  officeSymbol: string | null
  location: string | null
  notes: string | null
  _count?: { contacts: number; activities: number }
}

export interface GovernmentContact {
  id: string
  agencyName: string
  agencyOfficeId: string | null
  fullName: string
  title: string | null
  contactRole: GovContactRole
  email: string | null
  phone: string | null
  status: CrmContactStatus
  notes: string | null
  agencyOffice?: { id: string; officeName: string } | null
  _count?: { activities: number; followUps: number }
}

export interface CrmActivity {
  id: string
  activityType: CrmActivityType
  occurredAt: string
  subject: string
  summary: string | null
  notes: string | null
  durationMinutes: number | null
  location: string | null
  participants: string[]
  followUpNeeded: boolean
  agencyName: string | null
  governmentContact?: { id: string; fullName: string; contactRole?: GovContactRole } | null
  partner?: { id: string; name: string } | null
  partnerContact?: { id: string; fullName: string } | null
  opportunity?: { id: string; title: string; agency?: string } | null
}

export interface CrmFollowUp {
  id: string
  title: string
  notes: string | null
  dueAt: string
  status: CrmFollowUpStatus
  priority: CrmPriority
  ownerUserId: string | null
  completedAt: string | null
  governmentContact?: { id: string; fullName: string; agencyName: string } | null
  partner?: { id: string; name: string } | null
  opportunity?: { id: string; title: string } | null
}

export interface PartnerContact {
  id: string
  partnerId: string
  fullName: string
  title: string | null
  email: string | null
  phone: string | null
  isPrimary: boolean
  status: CrmContactStatus
  partner?: { id: string; name: string }
}

export interface AgencySummary {
  agencyName: string
  officeCount: number
  contactCount: number
  activityCount: number
  lastActivityAt: string | null
}

/**
 * SAM stores an agency as a dotted, inverted path. The server parses it so the
 * UI can show a name a person recognises instead of the raw string.
 */
export interface AgencyPath {
  department: string | null
  subTier: string | null
  office: string | null
  display: string
  segments: string[]
}

export interface OpportunityCrmContext {
  opportunityId: string
  agencyName: string | null
  agencyPath: AgencyPath
  offices: AgencyOffice[]
  contacts: GovernmentContact[]
  activities: CrmActivity[]
  nextFollowUp: CrmFollowUp | null
  openFollowUps: CrmFollowUp[]
  partnersEngaged: number
  valueNote: string
}

export interface PartnerCrmDetail {
  id: string
  name: string
  uei: string | null
  cage: string | null
  primaryNaicsCodes: string[]
  capabilities: string[]
  certifications: string[]
  geography: string | null
  contacts: PartnerContact[]
  activities: CrmActivity[]
  followUps: CrmFollowUp[]
  arrangements: Array<{
    id: string
    role: string
    teamingStatus: string
    agreementStatus: string
    opportunity?: { id: string; title: string; agency: string | null } | null
  }>
  performanceRecords: Array<{ id: string; createdAt: string }>
  relationship: RelationshipStrength
}

async function get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const res = await api.get(url, { params })
  return res.data.data as T
}
async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await api.post(url, body)
  return res.data.data as T
}

export const crmApi = {
  listAgencies: () => get<{ items: AgencySummary[]; note: string }>('/crm/agencies'),
  getAgency: (name: string) =>
    get<{ agencyName: string; offices: AgencyOffice[]; contacts: GovernmentContact[]; activities: CrmActivity[]; marketProfile: unknown }>(
      `/crm/agencies/${encodeURIComponent(name)}`,
    ),

  listOffices: (params?: Record<string, unknown>) => get<AgencyOffice[]>('/crm/offices', params),
  createOffice: (body: Record<string, unknown>) => post<AgencyOffice>('/crm/offices', body),

  listContacts: (params?: Record<string, unknown>) => get<GovernmentContact[]>('/crm/contacts', params),
  createContact: (body: Record<string, unknown>) => post<GovernmentContact>('/crm/contacts', body),
  getContact: (id: string) =>
    get<GovernmentContact & { activities: CrmActivity[]; followUps: CrmFollowUp[]; relationship: RelationshipStrength }>(`/crm/contacts/${id}`),
  updateContact: async (id: string, body: Record<string, unknown>) => {
    const res = await api.put(`/crm/contacts/${id}`, body)
    return res.data.data as GovernmentContact
  },

  listActivities: (params?: Record<string, unknown>) => get<CrmActivity[]>('/crm/activities', params),
  createActivity: (body: Record<string, unknown>) => post<CrmActivity>('/crm/activities', body),

  listFollowUps: (params?: Record<string, unknown>) => get<CrmFollowUp[]>('/crm/follow-ups', params),
  createFollowUp: (body: Record<string, unknown>) => post<CrmFollowUp>('/crm/follow-ups', body),
  transitionFollowUp: (id: string, status: CrmFollowUpStatus) =>
    post<CrmFollowUp>(`/crm/follow-ups/${id}/transition`, { status }),

  listPartnerContacts: (partnerId?: string) =>
    get<PartnerContact[]>('/crm/partner-contacts', partnerId ? { partnerId } : undefined),
  createPartnerContact: (body: Record<string, unknown>) => post<PartnerContact>('/crm/partner-contacts', body),
  getPartnerCrm: (id: string) => get<PartnerCrmDetail>(`/crm/partners/${id}`),

  opportunityContext: (opportunityId: string) => get<OpportunityCrmContext>(`/crm/opportunity-context/${opportunityId}`),
}

// -------------------------------------------------------------
// Partner portal access — granted from the partner's own CRM record, which is
// where someone is already looking when they decide to let a subcontractor in.
// -------------------------------------------------------------

export type EngagementScope = 'OPPORTUNITY' | 'TEAMING_ARRANGEMENT' | 'CONTRACT' | 'PURCHASE_ORDER'

export interface PortalUserRow {
  id: string
  email: string
  firstName: string
  lastName: string
  isActive: boolean
  invitedAt: string | null
  acceptedAt: string | null
  lastLoginAt: string | null
  revokedAt: string | null
  partner: { id: string; name: string }
  access: Array<{ id: string; scopeType: EngagementScope; scopeId: string; grantedAt: string }>
}

export interface ContractOption {
  id: string
  contractNumber: string
  title: string
}

export const partnerPortalAdminApi = {
  listUsers: (partnerId: string) => get<PortalUserRow[]>('/partner-portal/admin/users', { partnerId }),
  /** The raw invite token comes back exactly once and is never recoverable. */
  invite: (body: Record<string, unknown>) =>
    post<{ id: string; email: string; inviteToken: string; inviteExpiresAt: string }>('/partner-portal/admin/users', body),
  revokeUser: (id: string) => post(`/partner-portal/admin/users/${id}/revoke`, {}),
  grant: (body: Record<string, unknown>) => post<{ id: string }>('/partner-portal/admin/access', body),
  revokeAccess: (id: string) => post(`/partner-portal/admin/access/${id}/revoke`, {}),
}

// ---- What the subcontractor sent back, and the prime's decision on it ------

export type PartnerReviewStatus = 'PENDING_REVIEW' | 'ACCEPTED' | 'REJECTED'

export interface PartnerUploadRow {
  id: string
  title: string
  category: string
  fileName: string
  fileSize: number
  notes: string | null
  scopeType: EngagementScope
  scopeId: string
  reviewStatus: PartnerReviewStatus
  reviewNotes: string | null
  reviewedAt: string | null
  createdAt: string
  partner: { id: string; name: string }
}

export interface PartnerDeliverableSubmissionRow {
  id: string
  status: 'DRAFT' | 'SUBMITTED' | 'CHANGES_REQUESTED' | 'ACCEPTED_BY_PRIME'
  note: string | null
  fileName: string | null
  fileSize: number | null
  submittedAt: string | null
  reviewedAt: string | null
  reviewNotes: string | null
  createdAt: string
  partner: { id: string; name: string }
  deliverable: { id: string; name: string; cdrlNumber: string | null; dueDate: string | null; status: string; contractId: string }
}

export interface PartnerProfileChangeRow {
  id: string
  status: PartnerReviewStatus
  proposed: Record<string, unknown>
  previous: Record<string, unknown>
  submittedNote: string | null
  reviewNotes: string | null
  reviewedAt: string | null
  appliedAt: string | null
  createdAt: string
  partner: { id: string; name: string }
  portalUser: { id: string; email: string; firstName: string; lastName: string } | null
}

async function downloadTo(url: string, fileName: string): Promise<void> {
  const res = await api.get(url, { responseType: 'blob' })
  const href = URL.createObjectURL(res.data)
  const a = document.createElement('a')
  a.href = href
  a.download = fileName
  a.click()
  URL.revokeObjectURL(href)
}

export const partnerSubmissionsApi = {
  listUploads: async (): Promise<PartnerUploadRow[]> =>
    (await get<{ uploads: PartnerUploadRow[] }>('/partner-portal/admin/submissions')).uploads,
  reviewUpload: (id: string, body: { status: 'ACCEPTED' | 'REJECTED'; reviewNotes?: string | null }) =>
    post(`/partner-portal/admin/submissions/uploads/${id}/review`, body),
  downloadUpload: (id: string, fileName: string) =>
    downloadTo(`/partner-portal/admin/uploads/${id}/download`, fileName),

  listDeliverableSubmissions: () =>
    get<PartnerDeliverableSubmissionRow[]>('/partner-portal/admin/deliverable-submissions'),
  reviewDeliverableSubmission: (id: string, body: { status: 'ACCEPTED_BY_PRIME' | 'CHANGES_REQUESTED'; reviewNotes?: string | null }) =>
    post(`/partner-portal/admin/deliverable-submissions/${id}/review`, body),
  downloadDeliverableSubmission: (id: string, fileName: string) =>
    downloadTo(`/partner-portal/admin/deliverable-submissions/${id}/download`, fileName),

  listProfileChanges: () =>
    get<PartnerProfileChangeRow[]>('/partner-portal/admin/profile-change-requests'),
  reviewProfileChange: (id: string, body: { status: 'ACCEPTED' | 'REJECTED'; reviewNotes?: string | null }) =>
    post<{ appliedFields: string[] }>(`/partner-portal/admin/profile-change-requests/${id}/review`, body),
}

/** Contracts for the grant picker. Reads the existing contract list. */
export async function loadContractOptions(): Promise<ContractOption[]> {
  const res = await api.get('/contract-management', { params: { limit: 200 } })
  const payload = res.data?.data
  const rows = Array.isArray(payload) ? payload : (payload?.contracts ?? payload?.items ?? [])
  return (rows as Array<Record<string, unknown>>).map((c) => ({
    id: String(c.id),
    contractNumber: String(c.contractNumber ?? ''),
    title: String(c.title ?? 'Untitled'),
  }))
}

export interface OpportunityOption {
  id: string
  title: string
  agency: string | null
}

/**
 * Opportunities for the CRM's link pickers.
 *
 * Reads the existing opportunities endpoint — the CRM keeps no opportunity
 * list of its own.
 */
/**
 * Server-side opportunity search for the pickers.
 *
 * A firm can hold thousands of live notices, so the list is narrowed by the
 * API rather than fetched whole and filtered in the browser. An empty term
 * returns the soonest deadlines, which is the useful default for "link this to
 * something I am working on right now".
 */
export async function searchOpportunityOptions(term: string, limit = 10): Promise<OpportunityOption[]> {
  const res = await api.get('/opportunities', {
    params: { limit, sortBy: 'responseDeadline', ...(term ? { search: term } : {}) },
  })
  const payload = res.data?.data
  const rows = Array.isArray(payload) ? payload : (payload?.opportunities ?? payload?.items ?? [])
  return (rows as Array<Record<string, unknown>>).map((o) => ({
    id: String(o.id),
    title: String(o.title ?? 'Untitled'),
    agency: (o.agency as string | null) ?? null,
  }))
}

/** Resolve one opportunity so an already-chosen id can be shown by name. */
export async function getOpportunityOption(id: string): Promise<OpportunityOption | null> {
  try {
    const res = await api.get(`/opportunities/${id}`)
    const o = res.data?.data
    if (!o?.id) return null
    return { id: String(o.id), title: String(o.title ?? 'Untitled'), agency: (o.agency as string | null) ?? null }
  } catch {
    return null
  }
}
