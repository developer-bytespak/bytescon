// =============================================================
// §8.3 — API client for personnel, the knowledge hub and partner portal
// administration.
//
// Nothing is derived here. Resume status, qualification verification and
// submission review states all come from the server, because they are records
// of human decisions rather than presentation details.
// =============================================================
import { api } from './api'

export type EmploymentType = 'EMPLOYEE' | 'CONTRACTOR' | 'CONSULTANT' | 'SUBCONTRACTOR_STAFF' | 'PROSPECTIVE'
export type ResumeStatus = 'DRAFT' | 'APPROVED' | 'SUPERSEDED' | 'ARCHIVED'
export type QualificationVerification = 'UNVERIFIED' | 'VERIFIED' | 'REJECTED'
export type PersonnelSource = 'INTERNAL' | 'PARTNER_SUBMITTED' | 'IMPORTED_FROM_USER'
export type EngagementScope = 'OPPORTUNITY' | 'TEAMING_ARRANGEMENT' | 'CONTRACT' | 'PURCHASE_ORDER'

export const EMPLOYMENT_TYPES: EmploymentType[] = ['EMPLOYEE', 'CONTRACTOR', 'CONSULTANT', 'SUBCONTRACTOR_STAFF', 'PROSPECTIVE']

export interface PersonnelSummary {
  id: string
  firstName: string
  lastName: string
  jobTitle: string | null
  employmentType: EmploymentType
  source: PersonnelSource
  isActive: boolean
  isArchived: boolean
  user?: { id: string; email: string; isActive: boolean } | null
  qualifications: Array<{ id: string; laborCategory: string; verification: QualificationVerification }>
  resumes: Array<{ id: string; versionNumber: number; approvedAt: string | null }>
  _count?: { proposalUses: number; allocations: number }
}

export interface ResumeVersion {
  id: string
  versionNumber: number
  status: ResumeStatus
  title: string | null
  content: Record<string, unknown>
  source: PersonnelSource
  /** Present once a document has been attached to THIS version. */
  fileName: string | null
  fileSize: number | null
  approvedAt: string | null
  supersededAt: string | null
  createdAt: string
}

export interface PersonnelDetail extends PersonnelSummary {
  email: string | null
  phone: string | null
  location: string | null
  summary: string | null
  yearsExperience: number | null
  resumes: ResumeVersion[]
  qualifications: Array<{
    id: string; laborCategory: string; verification: QualificationVerification
    yearsExperience: number | null; evidence: string | null
    effectiveDate: string | null; expirationDate: string | null
  }>
  allocations: Array<{
    id: string; allocationPercent: string; startDate: string; endDate: string | null; status: string
    contract: { id: string; contractNumber: string; title: string }
  }>
  proposalUses: Array<{
    id: string; proposalRole: string | null; laborCategory: string | null; resumeId: string | null
    proposal: { id: string; title: string }
  }>
}


async function get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const res = await api.get(url, { params })
  return res.data.data as T
}
async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await api.post(url, body)
  return res.data.data as T
}
async function del<T>(url: string): Promise<T> {
  const res = await api.delete(url)
  return res.data.data as T
}

export const personnelApi = {
  list: (params?: Record<string, unknown>) => get<PersonnelSummary[]>('/personnel', params),
  get: (id: string) => get<PersonnelDetail>(`/personnel/${id}`),
  create: (body: Record<string, unknown>) => post<PersonnelDetail>('/personnel', body),
  importFromUser: (userId: string) => post<PersonnelDetail>(`/personnel/import-from-user/${userId}`, {}),
  archive: (id: string) => post<PersonnelDetail>(`/personnel/${id}/archive`, {}),

  addQualification: (id: string, body: Record<string, unknown>) => post(`/personnel/${id}/qualifications`, body),
  verifyQualification: (qualId: string, verification: QualificationVerification, evidence?: string) =>
    post(`/personnel/qualifications/${qualId}/verify`, { verification, evidence }),

  createResume: (id: string, body: Record<string, unknown>) => post<ResumeVersion>(`/personnel/${id}/resumes`, body),
  approveResume: (resumeId: string) => post<ResumeVersion>(`/personnel/resumes/${resumeId}/approve`, {}),
  uploadResumeFile: async (resumeId: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    const res = await api.post(`/personnel/resumes/${resumeId}/file`, form)
    return res.data.data as ResumeVersion
  },
  /** Streams the approved document rather than linking it, so the request carries auth. */
  downloadResumeFile: async (resumeId: string, fileName: string) => {
    const res = await api.get(`/personnel/resumes/${resumeId}/file`, { responseType: 'blob' })
    const url = URL.createObjectURL(res.data)
    const a = document.createElement('a'); a.href = url; a.download = fileName; a.click()
    URL.revokeObjectURL(url)
  },

  listKeyPersonnel: (proposalId: string) =>
    get<{ items: unknown[]; provenanceNote: string }>(`/personnel/proposals/${proposalId}/key-personnel`),
  removeKeyPersonnel: (id: string) => del(`/personnel/key-personnel/${id}`),
  addKeyPersonnel: (proposalId: string, body: Record<string, unknown>) =>
    post(`/personnel/proposals/${proposalId}/key-personnel`, body),
}

export const KNOWLEDGE_RESULT_TYPES = [
  'CAPABILITY', 'CAPABILITY_NARRATIVE', 'PAST_PERFORMANCE',
  'PERSONNEL', 'PERSONNEL_RESUME', 'TEMPLATE', 'STANDING_DOCUMENT',
] as const

export type KnowledgeResultType = (typeof KNOWLEDGE_RESULT_TYPES)[number]

export interface KnowledgeResult {
  type: KnowledgeResultType
  id: string
  title: string
  summary: string | null
  sourceRoute: string
  /** The human-set approval/verification state, verbatim from the server. */
  evidenceState: string
  updatedAt: string
}

export interface KnowledgeSearchResponse {
  query: string
  results: KnowledgeResult[]
  totalByType: Record<string, number>
  total: number
  limit: number
  offset: number
  /** How the search actually works. Rendered, not paraphrased. */
  method: string
}

export const knowledgeApi = {
  search: (params: Record<string, unknown>) => get<KnowledgeSearchResponse>('/knowledge/search', params),
}

