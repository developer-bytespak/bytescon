import { api } from './api'

export interface FetchRow {
  id: string
  firm: string
  kind: 'sam' | 'source'
  source: string
  trigger: string | null
  triggerDetail: string | null
  status: string
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
  requests: number | null
  pages: number | null
  fetched: number | null
  added: number | null
  updated: number | null
  error: string | null
}

export interface Counted { key: string; count: number }

export interface Holdings {
  total: number
  open: number
  closed: number
  dueWithin: { days7: number; days30: number; days90: number; later: number }
  byStatus: Counted[]
  bySource: Counted[]
  byBusinessType: Counted[]
  byNoticeType: Counted[]
  bySetAside: Counted[]
  topAgencies: Counted[]
  postedByWeek: Array<{ week: string; count: number }>
}

export interface AccountRow { name: string; businessType: string; realOpen: number; inventedOpen: number }

export interface FirmRow {
  id: string
  name: string
  active: boolean
  ownSamKey: boolean
  total: number
  open: number
  samFetches30d: number
  samFailures30d: number
  sourceRuns30d: number
  sourceFailures30d: number
  lastSamFetch: { at: string | null; ok: boolean; error: string | null } | null
}

export interface FetchedNotice {
  id: string
  title: string
  agency: string
  naicsCode: string
  noticeType: string | null
  source: string
  responseDeadline: string
  postedDate: string | null
  sourceUrl: string | null
  createdAt: string
  firm: string
  open: boolean
  businessType: string | null
}

export const fetchHistoryApi = {
  access: () => api.get<{ data: { allowed: boolean } }>('/fetch-history/access').then((r) => r.data.data.allowed),
  history: (days: number, firmId?: string) =>
    api.get<{ data: { days: number; scope: 'pool' | 'firm' | 'all'; fetches: FetchRow[]; capped: boolean } }>('/fetch-history', { params: { days, firmId } }).then((r) => r.data.data),
  breakdown: (firmId?: string) =>
    api.get<{ data: { holdings: Holdings; accounts: AccountRow[] | null; firms: FirmRow[] | null } }>('/fetch-history/breakdown', { params: { firmId } }).then((r) => r.data.data),
  notices: (params: { firmId?: string; runKind?: 'sam' | 'source'; runId?: string; search?: string; page?: number }) =>
    api.get<{ data: { notices: FetchedNotice[]; total: number; page: number; pageSize: number } }>('/fetch-history/notices', { params }).then((r) => r.data.data),
}
